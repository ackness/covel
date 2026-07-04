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

  constructor(private readonly adapter: SettingsBackendAdapter) {
    this.loaded = new Promise<void>((resolve) => {
      this.loadResolve = resolve;
    });
  }

  async init(): Promise<void> {
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
    this.loadResolve();
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
      if (str.trim().length === 0) this.secrets.delete(provider);
      else this.secrets.set(provider, str);
      await this.adapter.saveSecrets(Object.fromEntries(this.secrets));
    } else {
      this.values.set(key, value);
      await this.adapter.save(this.serializeEntries());
    }
    this.notify(key, value);
  }

  async clear(key: SettingKey): Promise<void> {
    const entry = this.registry.get(key);
    const backend =
      entry?.backend ?? (key.startsWith("keys.") ? "keys" : "settings");
    if (backend === "keys") {
      this.secrets.delete(this.stripKeysPrefix(key));
      await this.adapter.saveSecrets(Object.fromEntries(this.secrets));
    } else {
      this.values.delete(key);
      await this.adapter.save(this.serializeEntries());
    }
    const fresh = entry ? entry.default : undefined;
    this.notify(key, fresh);
  }

  async clearAll(): Promise<void> {
    this.values.clear();
    this.secrets.clear();
    await Promise.all([this.adapter.save({}), this.adapter.saveSecrets({})]);
    for (const entry of this.registry.values()) {
      this.notify(entry.key, entry.default);
    }
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
    for (const [key, value] of nonSecretUpdates) {
      this.values.set(key, value);
    }
    for (const [provider, keyValue] of secretUpdates) {
      this.secrets.set(provider, keyValue);
    }
    if (nonSecretUpdates.length > 0) {
      await this.adapter.save(this.serializeEntries());
    }
    if (secretUpdates.length > 0) {
      await this.adapter.saveSecrets(Object.fromEntries(this.secrets));
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
