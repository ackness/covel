import {
  type SettingEntry,
  type SettingGroup,
  type SettingKey,
  type SettingsBackendAdapter,
  type SettingsExportBundle,
  type SettingsListener,
  type SettingsPersistenceErrorListener,
  type SettingsStoreApi,
} from "./types.js";
import type { SettingsPersistenceBundle } from "@covel/shared/settings-persistence";
import {
  VersionedSettingsPersistence,
  sameSettingValue,
} from "./versioned-persistence.js";

/**
 * Core settings store. Tier-aware via the injected backend adapter.
 *
 * - Registry tracks schema + default + UI metadata per key.
 * - In-memory cache is hydrated from the adapter at `init()`.
 * - `set()` validates against the Zod schema, persists through the adapter,
 *   and notifies subscribers.
 * - Secrets (backend: 'keys') are routed to a separate channel (`saveSecrets`)
 *   so desktop builds can keep them in `keys.env` with mode 600.
 */
export class SettingsStore implements SettingsStoreApi {
  private readonly registry = new Map<SettingKey, SettingEntry>();
  private readonly values = new Map<SettingKey, unknown>();
  private readonly secrets = new Map<string, string>();
  private readonly keyListeners = new Map<SettingKey, Set<SettingsListener>>();
  private readonly globalListeners = new Set<SettingsListener>();
  private readonly persistenceErrorListeners =
    new Set<SettingsPersistenceErrorListener>();
  private readonly invalidHydratedKeys = new Set<SettingKey>();
  /**
   * Full snapshots must reach each backend in mutation order. Without this
   * queue, a slow older save can finish after a newer one and silently erase
   * the latest provider, model, or API-key configuration on disk.
   */
  private readonly persistTails: Record<"values" | "secrets", Promise<void>> = {
    values: Promise.resolve(),
    secrets: Promise.resolve(),
  };
  /** Last snapshot that the backend confirmed for each independently saved map. */
  private readonly persistedSnapshots = {
    values: new Map<SettingKey, unknown>(),
    secrets: new Map<string, string>(),
  };
  /** Monotonic mutation revisions keep an older failure from undoing newer state. */
  private readonly persistRevisions = { values: 0, secrets: 0 };
  private loaded: Promise<void>;
  private loadResolve!: () => void;
  /** One hydration generation per store instance; concurrent callers share it. */
  private initPromise: Promise<void> | null = null;
  private hydrationState: "pending" | "ready" | "failed" = "pending";
  /** Set when `init()` could not read existing state. See {@link assertHydrated}. */
  private hydrationError: Error | null = null;
  private versionedPersistence: VersionedSettingsPersistence | null = null;

  constructor(private readonly adapter: SettingsBackendAdapter) {
    this.loaded = new Promise<void>((resolve) => {
      this.loadResolve = resolve;
    });
  }

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.hydrate();
    return this.initPromise;
  }

  private async hydrate(): Promise<void> {
    try {
      const versioned = this.hasVersionedPersistence();
      const [stored, secrets] = await Promise.all([
        versioned ? this.adapter.loadWithRevision!() : this.adapter.load(),
        this.adapter.loadSecrets(),
      ]);
      const versionedStored = stored as SettingsPersistenceBundle;
      const entries = versioned
        ? versionedStored.entries
        : (stored as Record<SettingKey, unknown>);
      const hydratedValues = new Map<SettingKey, unknown>();
      for (const [key, value] of Object.entries(entries)) {
        this.assertNonSecretEntry(key);
        const entry = this.registry.get(key);
        if (entry && !entry.schema.safeParse(value).success) {
          throw new Error(`Settings hydration validation failed for ${key}`);
        }
        hydratedValues.set(key, value);
      }
      const hydratedSecrets = new Map<string, string>();
      for (const [provider, keyValue] of Object.entries(secrets)) {
        if (typeof keyValue === "string" && keyValue.length > 0) {
          hydratedSecrets.set(provider, keyValue);
        }
      }
      this.restore(this.values, hydratedValues);
      this.restore(this.secrets, hydratedSecrets);
      this.restore(this.persistedSnapshots.values, this.values);
      this.restore(this.persistedSnapshots.secrets, this.secrets);
      if (versioned) {
        this.versionedPersistence = new VersionedSettingsPersistence(
          this.adapter,
          versionedStored,
          (next) => {
            this.assertHydrated();
            for (const [key, value] of Object.entries(next)) {
              this.assertNonSecretEntry(key);
              const entry = this.registry.get(key);
              if (entry && !entry.schema.safeParse(value).success) {
                throw new Error(
                  `Settings synchronization validation failed for ${key}`,
                );
              }
            }
          },
          (next) => this.replaceVisibleValues(next),
        );
      }
      this.hydrationError = null;
      this.hydrationState = "ready";
    } catch (err) {
      // Boot continues on defaults (read-only) rather than failing hard, but
      // writes are refused: every save is a full snapshot, so writing from a
      // half-empty map would destroy the settings/keys we failed to read.
      this.hydrationError = err instanceof Error ? err : new Error(String(err));
      this.hydrationState = "failed";
      this.values.clear();
      this.secrets.clear();
      console.error("[settings] hydration failed — writes disabled", err);
    } finally {
      this.loadResolve();
    }
  }

  /** Whether `init()` successfully read the persisted state. */
  isHydrated(): boolean {
    return this.hydrationState === "ready";
  }

  private assertHydrated(): void {
    if (this.hydrationState === "pending") {
      throw new Error(
        "[settings] refusing to write: store is not initialized; call and await init() first",
      );
    }
    if (this.hydrationState === "failed") {
      throw new Error(
        `[settings] refusing to write: state was never loaded (${this.hydrationError?.message ?? "unknown hydration error"})`,
      );
    }
  }

  /**
   * Apply an in-memory mutation and persist it. A latest failed mutation rolls
   * back to the last backend-confirmed snapshot; an older failure leaves the
   * newer optimistic snapshot alone because that queued save includes it.
   *
   * Without the rollback a single failed write (localStorage quota, sidecar
   * hiccup) leaves the map ahead of storage. Every UI call site is
   * fire-and-forget, so the player gets no signal, and each later write
   * re-serialises the same oversized/stale map and fails the same way — the
   * store is poisoned until reload.
   */
  private async persist(
    target: "values" | "secrets",
    mutate: () => void,
    keys: readonly SettingKey[] = [],
  ): Promise<void> {
    this.assertHydrated();
    if (target === "values" && this.versionedPersistence) {
      mutate();
      await this.versionedPersistence.persist(keys, this.serializeEntries());
      return;
    }
    // Mutate synchronously so callers retain read-after-write behaviour, then
    // capture this mutation's full snapshot and enqueue only the backend I/O.
    mutate();
    const revision = ++this.persistRevisions[target];
    const snapshot =
      target === "values"
        ? this.serializeEntries()
        : (Object.fromEntries(this.secrets) as Record<string, string>);
    try {
      await this.enqueueSnapshot(target, snapshot);
      this.replacePersistedSnapshot(target, snapshot);
    } catch (err) {
      if (this.persistRevisions[target] === revision) {
        this.restore(
          target === "values" ? this.values : this.secrets,
          this.persistedSnapshots[target] as Map<string, unknown>,
        );
      }
      throw err;
    }
  }

  private replacePersistedSnapshot(
    target: "values" | "secrets",
    snapshot: Record<string, unknown> | Record<string, string>,
  ): void {
    const persisted = this.persistedSnapshots[target] as Map<string, unknown>;
    persisted.clear();
    for (const [key, value] of Object.entries(snapshot)) {
      persisted.set(key, structuredClone(value));
    }
  }

  private enqueueSnapshot(
    target: "values" | "secrets",
    snapshot: Record<string, unknown> | Record<string, string>,
  ): Promise<void> {
    const operation = this.persistTails[target].then(async () => {
      if (this.hydrationState === "failed") {
        throw (
          this.hydrationError ?? new Error("settings persistence is read-only")
        );
      }
      if (target === "secrets") {
        await this.adapter.saveSecrets(snapshot as Record<string, string>);
        return;
      }
      await this.adapter.save(snapshot as Record<SettingKey, unknown>);
    });
    // Keep the queue usable after a rejected write while returning the
    // original rejection to the caller that owns that mutation.
    this.persistTails[target] = operation.catch(() => undefined);
    return operation;
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  async refresh(): Promise<void> {
    this.assertHydrated();
    await this.versionedPersistence?.refresh();
  }

  private replaceVisibleValues(next: Record<SettingKey, unknown>): void {
    const previous = this.serializeEntries();
    this.restore(this.values, new Map(Object.entries(next)));
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of keys) {
      if (
        !sameSettingValue(previous[key], next[key]) ||
        Object.hasOwn(previous, key) !== Object.hasOwn(next, key)
      ) {
        this.notify(key, this.get(key));
      }
    }
  }

  private hasVersionedPersistence(): boolean {
    return (
      typeof this.adapter.loadWithRevision === "function" &&
      typeof this.adapter.saveWithRevision === "function"
    );
  }

  private observePersistence<T>(promise: Promise<T>): Promise<T> {
    void promise.catch((error: unknown) => {
      this.emitPersistenceError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    return promise;
  }

  private emitPersistenceError(error: Error): void {
    for (const listener of this.persistenceErrorListeners) listener(error);
  }

  register<T>(entry: SettingEntry<T>): void {
    this.registry.set(entry.key, entry as SettingEntry);
    if (
      this.hydrationState === "ready" &&
      this.values.has(entry.key) &&
      (this.isSecretKey(entry.key) ||
        !entry.schema.safeParse(this.values.get(entry.key)).success)
    ) {
      this.invalidHydratedKeys.add(entry.key);
      this.hydrationError = new Error(
        `Settings hydration validation failed for dynamically registered ${entry.key}`,
      );
      this.hydrationState = "failed";
      this.emitPersistenceError(this.hydrationError);
    }
  }

  get<T>(key: SettingKey): T {
    const entry = this.registry.get(key);
    if (this.isSecretKey(key)) {
      const provider = this.stripKeysPrefix(key);
      const val = this.secrets.get(provider);
      if (val !== undefined) return val as T;
      return (entry?.default ?? "") as T;
    }
    if (this.invalidHydratedKeys.has(key) && entry) return entry.default as T;
    if (this.values.has(key)) return this.values.get(key) as T;
    if (entry) return entry.default as T;
    return undefined as T;
  }

  has(key: SettingKey): boolean {
    if (this.isSecretKey(key)) {
      return this.secrets.has(this.stripKeysPrefix(key));
    }
    if (this.invalidHydratedKeys.has(key)) return false;
    return this.values.has(key);
  }

  set<T>(key: SettingKey, value: T): Promise<void> {
    try {
      const entry = this.registry.get(key);
      if (entry) {
        const parsed = entry.schema.safeParse(value);
        if (!parsed.success) {
          throw new Error(
            `Settings validation failed for ${key}: ${parsed.error.message}`,
          );
        }
      }
      const operation = this.isSecretKey(key)
        ? this.persist("secrets", () => {
            const provider = this.stripKeysPrefix(key);
            const str = typeof value === "string" ? value : String(value ?? "");
            if (str.trim().length === 0) this.secrets.delete(provider);
            else this.secrets.set(provider, str);
          })
        : this.persist(
            "values",
            () => {
              this.values.set(key, value);
            },
            [key],
          );
      return this.observePersistence(
        operation.then(() => this.notify(key, this.get(key))),
      );
    } catch (error) {
      return this.observePersistence(Promise.reject(error));
    }
  }

  clear(key: SettingKey): Promise<void> {
    try {
      const entry = this.registry.get(key);
      const operation = this.isSecretKey(key)
        ? this.persist("secrets", () => {
            this.secrets.delete(this.stripKeysPrefix(key));
          })
        : this.persist(
            "values",
            () => {
              this.values.delete(key);
            },
            [key],
          );
      return this.observePersistence(
        operation.then(() =>
          this.notify(key, entry ? entry.default : undefined),
        ),
      );
    } catch (error) {
      return this.observePersistence(Promise.reject(error));
    }
  }

  clearAll(): Promise<void> {
    // Guarded like every other write. A hydration failure makes the UI show
    // defaults, which reads to the player as "my settings are gone" — and
    // their natural response is to hit Reset, which would then wipe the very
    // settings.json / keys.env we failed to read.
    try {
      this.assertHydrated();
      return this.observePersistence(
        Promise.all([
          this.persist("values", () => this.values.clear(), [
            ...this.values.keys(),
          ]),
          this.persist("secrets", () => this.secrets.clear()),
        ]).then(() => {
          for (const entry of this.registry.values()) {
            this.notify(entry.key, entry.default);
          }
        }),
      );
    } catch (error) {
      return this.observePersistence(Promise.reject(error));
    }
  }

  private restore<V>(target: Map<string, V>, snapshot: Map<string, V>): void {
    target.clear();
    for (const [k, v] of snapshot) target.set(k, structuredClone(v));
  }

  list(group?: SettingGroup): readonly SettingEntry[] {
    const all = [...this.registry.values()];
    return group ? all.filter((e) => e.group === group) : all;
  }

  listEntries(): readonly SettingEntry[] {
    return [...this.registry.values()];
  }

  snapshotSecrets(): Record<string, string> {
    return Object.fromEntries(this.secrets);
  }

  async export(
    opts: { includeSecrets?: boolean } = {},
  ): Promise<SettingsExportBundle> {
    const bundle: SettingsExportBundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      entries: this.serializeEntries(),
      ...(opts.includeSecrets
        ? { keys: Object.fromEntries(this.secrets) }
        : {}),
    };
    return bundle;
  }

  import(
    bundle: SettingsExportBundle,
    opts: { keys: readonly SettingKey[]; includeSecrets?: boolean },
  ): Promise<void> {
    return this.observePersistence(this.importInternal(bundle, opts));
  }

  private async importInternal(
    bundle: SettingsExportBundle,
    opts: { keys: readonly SettingKey[]; includeSecrets?: boolean },
  ): Promise<void> {
    const selected = new Set(opts.keys);
    const nonSecretUpdates: Array<[SettingKey, unknown]> = [];
    const secretUpdates: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(bundle.entries)) {
      if (!selected.has(key)) continue;
      this.assertNonSecretEntry(key);
      const entry = this.registry.get(key);
      if (entry) {
        const parsed = entry.schema.safeParse(value);
        if (!parsed.success) continue;
      }
      nonSecretUpdates.push([key, value]);
    }
    if (opts.includeSecrets && bundle.keys) {
      for (const [provider, keyValue] of Object.entries(bundle.keys)) {
        if (typeof keyValue === "string" && keyValue.length > 0) {
          secretUpdates.push([provider, keyValue]);
        }
      }
    }
    // An import merges into existing state, so a failed write must not leave
    // the map holding values that never reached storage.
    if (nonSecretUpdates.length > 0) {
      await this.persist(
        "values",
        () => {
          for (const [key, value] of nonSecretUpdates)
            this.values.set(key, value);
        },
        nonSecretUpdates.map(([key]) => key),
      );
    }
    if (secretUpdates.length > 0) {
      await this.persist("secrets", () => {
        for (const [provider, keyValue] of secretUpdates) {
          this.secrets.set(provider, keyValue);
        }
      });
    }
    for (const [key, value] of nonSecretUpdates) {
      this.notify(key, value);
    }
  }

  subscribe<T>(key: SettingKey, handler: (value: T) => void): () => void {
    let set = this.keyListeners.get(key);
    if (!set) {
      set = new Set();
      this.keyListeners.set(key, set);
    }
    const wrapped: SettingsListener = (value) => handler(value as T);
    set.add(wrapped);
    const listenerSet = set;
    return () => {
      listenerSet.delete(wrapped);
    };
  }

  subscribeAll(handler: SettingsListener): () => void {
    this.globalListeners.add(handler);
    return () => {
      this.globalListeners.delete(handler);
    };
  }

  subscribePersistenceErrors(
    handler: SettingsPersistenceErrorListener,
  ): () => void {
    this.persistenceErrorListeners.add(handler);
    return () => this.persistenceErrorListeners.delete(handler);
  }

  private notify(key: SettingKey, value: unknown): void {
    const listeners = this.keyListeners.get(key);
    if (listeners) {
      for (const h of listeners) h(value, key);
    }
    for (const h of this.globalListeners) h(value, key);
  }

  private serializeEntries(): Record<SettingKey, unknown> {
    return structuredClone(
      Object.fromEntries(
        [...this.values].filter(([key]) => !this.isSecretKey(key)),
      ),
    );
  }

  private isSecretKey(key: SettingKey): boolean {
    const entry = this.registry.get(key);
    return (
      key.startsWith("keys.") ||
      entry?.backend === "keys" ||
      entry?.secret === true
    );
  }

  private assertNonSecretEntry(key: SettingKey): void {
    if (this.isSecretKey(key)) {
      throw new Error(
        `Secret setting ${key} must use the separate keys channel`,
      );
    }
  }

  private stripKeysPrefix(key: SettingKey): string {
    return key.startsWith("keys.") ? key.slice("keys.".length) : key;
  }
}
