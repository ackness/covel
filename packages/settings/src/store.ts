import type {
  SettingEntry,
  SettingGroup,
  SettingKey,
  SettingsBackendAdapter,
  SettingsExportBundle,
  SettingsListener,
  SettingsStoreApi,
} from "./types.js";

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
  private loaded: Promise<void>;
  private loadResolve!: () => void;
  /** Set when `init()` could not read existing state. See {@link assertHydrated}. */
  private hydrationError: Error | null = null;

  constructor(private readonly adapter: SettingsBackendAdapter) {
    this.loaded = new Promise<void>((resolve) => {
      this.loadResolve = resolve;
    });
  }

  async init(): Promise<void> {
    try {
      const [entries, secrets] = await Promise.all([
        this.adapter.load(),
        this.adapter.loadSecrets(),
      ]);
      for (const [key, value] of Object.entries(entries)) {
        this.values.set(key, value);
      }
      for (const [provider, keyValue] of Object.entries(secrets)) {
        if (typeof keyValue === "string" && keyValue.length > 0) {
          this.secrets.set(provider, keyValue);
        }
      }
      this.hydrationError = null;
    } catch (err) {
      // Boot continues on defaults (read-only) rather than failing hard, but
      // writes are refused: every save is a full snapshot, so writing from a
      // half-empty map would destroy the settings/keys we failed to read.
      this.hydrationError = err instanceof Error ? err : new Error(String(err));
      console.error("[settings] hydration failed — writes disabled", err);
    } finally {
      this.loadResolve();
    }
  }

  /** Whether `init()` successfully read the persisted state. */
  isHydrated(): boolean {
    return this.hydrationError === null;
  }

  private assertHydrated(): void {
    if (this.hydrationError) {
      throw new Error(
        `[settings] refusing to write: state was never loaded (${this.hydrationError.message})`,
      );
    }
  }

  /**
   * Apply an in-memory mutation and persist it, restoring the previous state if
   * the adapter rejects.
   *
   * Without the rollback a single failed write (localStorage quota, sidecar
   * hiccup) leaves the map ahead of storage. Every UI call site is
   * fire-and-forget, so the player gets no signal, and each later write
   * re-serialises the same oversized/stale map and fails the same way — the
   * store is poisoned until reload.
   */
  private async persist(
    target: "values" | "secrets",
    mutate: () => () => void,
  ): Promise<void> {
    this.assertHydrated();
    // `mutate` runs synchronously and returns its own undo. Two reasons it is
    // not deferred into a queue and does not snapshot the whole map:
    //   - Callers read back synchronously (`applyThemeSelection` does
    //     `void set(...)` then `get(...)` in the same tick), so the value must
    //     be visible immediately.
    //   - A whole-map snapshot would, on failure, also revert a *concurrent*
    //     write that had already succeeded. Undoing only the key we touched
    //     leaves other writers alone.
    const undo = mutate();
    try {
      await (target === "values"
        ? this.adapter.save(this.serializeEntries())
        : this.adapter.saveSecrets(
            Object.fromEntries(this.secrets) as Record<string, string>,
          ));
    } catch (err) {
      undo();
      throw err;
    }
  }

  /** Capture a key's current state so a failed write can put it back. */
  private undoFor<V>(map: Map<string, V>, key: string): () => void {
    const had = map.has(key);
    const previous = map.get(key);
    return () => {
      if (had) map.set(key, previous as V);
      else map.delete(key);
    };
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  register<T>(entry: SettingEntry<T>): void {
    this.registry.set(entry.key, entry as SettingEntry);
  }

  get<T>(key: SettingKey): T {
    const entry = this.registry.get(key);
    const backend =
      entry?.backend ?? (key.startsWith("keys.") ? "keys" : "settings");
    if (backend === "keys") {
      const provider = this.stripKeysPrefix(key);
      const val = this.secrets.get(provider);
      if (val !== undefined) return val as T;
      return (entry?.default ?? "") as T;
    }
    if (this.values.has(key)) return this.values.get(key) as T;
    if (entry) return entry.default as T;
    return undefined as T;
  }

  has(key: SettingKey): boolean {
    const entry = this.registry.get(key);
    const backend =
      entry?.backend ?? (key.startsWith("keys.") ? "keys" : "settings");
    if (backend === "keys") {
      return this.secrets.has(this.stripKeysPrefix(key));
    }
    return this.values.has(key);
  }

  async set<T>(key: SettingKey, value: T): Promise<void> {
    const entry = this.registry.get(key);
    if (entry) {
      const parsed = entry.schema.safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `Settings validation failed for ${key}: ${parsed.error.message}`,
        );
      }
    }
    const backend =
      entry?.backend ?? (key.startsWith("keys.") ? "keys" : "settings");
    if (backend === "keys") {
      const provider = this.stripKeysPrefix(key);
      const str = typeof value === "string" ? value : String(value ?? "");
      await this.persist("secrets", () => {
        const undo = this.undoFor(this.secrets, provider);
        if (str.trim().length === 0) this.secrets.delete(provider);
        else this.secrets.set(provider, str);
        return undo;
      });
    } else {
      await this.persist("values", () => {
        const undo = this.undoFor(this.values, key);
        this.values.set(key, value);
        return undo;
      });
    }
    this.notify(key, value);
  }

  async clear(key: SettingKey): Promise<void> {
    const entry = this.registry.get(key);
    const backend =
      entry?.backend ?? (key.startsWith("keys.") ? "keys" : "settings");
    if (backend === "keys") {
      await this.persist("secrets", () => {
        const provider = this.stripKeysPrefix(key);
        const undo = this.undoFor(this.secrets, provider);
        this.secrets.delete(provider);
        return undo;
      });
    } else {
      await this.persist("values", () => {
        const undo = this.undoFor(this.values, key);
        this.values.delete(key);
        return undo;
      });
    }
    const fresh = entry ? entry.default : undefined;
    this.notify(key, fresh);
  }

  async clearAll(): Promise<void> {
    // Guarded like every other write. A hydration failure makes the UI show
    // defaults, which reads to the player as "my settings are gone" — and
    // their natural response is to hit Reset, which would then wipe the very
    // settings.json / keys.env we failed to read.
    this.assertHydrated();
    // A wipe is the one write where a whole-map snapshot IS the right undo —
    // it touches every key by definition.
    const valuesSnapshot = new Map(this.values);
    const secretsSnapshot = new Map(this.secrets);
    this.values.clear();
    this.secrets.clear();
    try {
      await Promise.all([this.adapter.save({}), this.adapter.saveSecrets({})]);
    } catch (err) {
      this.restore(this.values, valuesSnapshot);
      this.restore(this.secrets, secretsSnapshot);
      throw err;
    }
    for (const entry of this.registry.values()) {
      this.notify(entry.key, entry.default);
    }
  }

  private restore<V>(target: Map<string, V>, snapshot: Map<string, V>): void {
    target.clear();
    for (const [k, v] of snapshot) target.set(k, v);
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

  async import(
    bundle: SettingsExportBundle,
    opts: { keys: readonly SettingKey[]; includeSecrets?: boolean },
  ): Promise<void> {
    const selected = new Set(opts.keys);
    const nonSecretUpdates: Array<[SettingKey, unknown]> = [];
    const secretUpdates: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(bundle.entries)) {
      if (!selected.has(key)) continue;
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
      await this.persist("values", () => {
        const undos = nonSecretUpdates.map(([key]) =>
          this.undoFor(this.values, key),
        );
        for (const [key, value] of nonSecretUpdates)
          this.values.set(key, value);
        return () => undos.forEach((undo) => undo());
      });
    }
    if (secretUpdates.length > 0) {
      await this.persist("secrets", () => {
        const undos = secretUpdates.map(([provider]) =>
          this.undoFor(this.secrets, provider),
        );
        for (const [provider, keyValue] of secretUpdates) {
          this.secrets.set(provider, keyValue);
        }
        return () => undos.forEach((undo) => undo());
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

  private notify(key: SettingKey, value: unknown): void {
    const listeners = this.keyListeners.get(key);
    if (listeners) {
      for (const h of listeners) h(value, key);
    }
    for (const h of this.globalListeners) h(value, key);
  }

  private serializeEntries(): Record<SettingKey, unknown> {
    return Object.fromEntries(this.values);
  }

  private stripKeysPrefix(key: SettingKey): string {
    return key.startsWith("keys.") ? key.slice("keys.".length) : key;
  }
}
