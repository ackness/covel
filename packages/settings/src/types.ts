import type { ZodType } from "zod";
import type { I18nText } from "@covel/shared";
import type { SettingsPersistenceBundle } from "@covel/shared/settings-persistence";

export type SettingKey = string;

export type SettingBackend = "settings" | "keys";

export type WidgetKind =
  | "text"
  | "secret"
  | "select"
  | "slider"
  | "toggle"
  | "number"
  | "textarea"
  | "json"
  | "custom";

export type SettingGroup = "general" | "llm" | "plugin" | "desktop" | "data";

export interface SettingOption {
  readonly value: string;
  readonly label: I18nText;
}

export interface SettingEntry<T = unknown> {
  readonly key: SettingKey;
  readonly schema: ZodType<T>;
  readonly default: T;
  readonly group: SettingGroup;
  readonly pluginId?: string;
  readonly label: I18nText;
  readonly description?: I18nText;
  readonly widget?: WidgetKind;
  readonly options?: readonly SettingOption[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly backend?: SettingBackend;
  /** Secret entries always use the separate keys channel, never ordinary exports. */
  readonly secret?: boolean;
}

export interface SettingsExportBundle {
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly entries: Record<SettingKey, unknown>;
  readonly keys?: Record<string, string>;
}

export interface SettingsBackendAdapter {
  load(): Promise<Record<SettingKey, unknown>>;
  save(entries: Record<SettingKey, unknown>): Promise<void>;
  loadSecrets(): Promise<Record<string, string>>;
  /** Atomically patch providers: omitted keys are unchanged; null deletes. */
  saveSecrets(patch: Record<string, string | null>): Promise<void>;
  /** Optional v2 persistence protocol. Legacy custom adapters remain valid. */
  loadWithRevision?(): Promise<SettingsPersistenceBundle>;
  saveWithRevision?(
    entries: Record<SettingKey, unknown>,
    expectedRevision: number,
  ): Promise<SettingsPersistenceBundle>;
  /**
   * Where the backend put a bundle this build cannot use (an earlier format,
   * no version, damaged text), or null. The backend moved it aside during
   * load, so the settings now hold their defaults. Each move is reported once.
   */
  takeArchivedBundle?(): Promise<string | null>;
  /**
   * Keep a copy of the stored bundle as it is now, and return where it is.
   * The store asks for one before it drops stored values that the current
   * schemas refuse. Without this method, or when it fails, the store drops
   * nothing and stays read-only. `label` goes into the name of the copy and
   * says why it was kept: `conflict` by default, `edit` before a raw edit.
   */
  backupBundle?(label?: string): Promise<string>;
  /** The copies kept by the move on load and by `backupBundle`. */
  listBackups?(): Promise<readonly string[]>;
  /** The text of one kept copy; null when the name is not one of them. */
  readBackup?(name: string): Promise<string | null>;
}

export class SettingsRevisionConflictError extends Error {
  readonly code = "settings_revision_conflict";

  constructor(
    readonly currentRevision: number,
    readonly conflictingKeys: readonly SettingKey[] = [],
  ) {
    super(`Settings changed in another instance (revision ${currentRevision})`);
    this.name = "SettingsRevisionConflictError";
  }
}

export type SettingsListener = (value: unknown, key: SettingKey) => void;
export type SettingsPersistenceErrorListener = (error: Error) => void;

/** Stored values the store dropped because the current schemas refuse them. */
export interface SettingsRepair {
  /** Where the backend kept the bundle as it was before the values went. */
  readonly backup: string;
  /** The keys that now read their defaults. */
  readonly keys: readonly SettingKey[];
}
export type SettingsRepairListener = (repair: SettingsRepair) => void;

export interface SettingsStoreApi {
  get<T>(key: SettingKey): T;
  has(key: SettingKey): boolean;
  list(group?: SettingGroup): readonly SettingEntry[];
  listEntries(): readonly SettingEntry[];
  export(opts?: { includeSecrets?: boolean }): Promise<SettingsExportBundle>;
  set<T>(key: SettingKey, value: T): Promise<void>;
  /** Validate and persist ordinary settings together; secret keys are rejected. */
  setMany(entries: Readonly<Record<SettingKey, unknown>>): Promise<void>;
  /** Atomically replace ordinary entries only if the complete editor base still matches. */
  replaceEntries(
    entries: Readonly<Record<SettingKey, unknown>>,
    expectedEntries: Readonly<Record<SettingKey, unknown>>,
  ): Promise<void>;
  clear(key: SettingKey): Promise<void>;
  clearAll(): Promise<void>;
  import(
    bundle: SettingsExportBundle,
    opts: { keys: readonly SettingKey[]; includeSecrets?: boolean },
  ): Promise<void>;
  subscribe<T>(key: SettingKey, handler: (value: T) => void): () => void;
  subscribeAll(handler: SettingsListener): () => void;
  subscribePersistenceErrors(
    handler: SettingsPersistenceErrorListener,
  ): () => void;
  /** Told each time stored values were dropped and a copy was kept. */
  subscribeRepairs(handler: SettingsRepairListener): () => void;
  /**
   * Keep a copy of the stored settings as they are now, before a change that
   * replaces many of them. Null when there is nothing stored to keep or the
   * backend keeps no copies.
   */
  backup(label: string): Promise<string | null>;
  /** The copies of earlier bundles the backend keeps, by name. */
  listBackups(): Promise<readonly string[]>;
  /** The text of one kept copy; null when there is no such copy. */
  readBackup(name: string): Promise<string | null>;
  register<T>(entry: SettingEntry<T>): void;
  ready(): Promise<void>;
  /** Refresh non-secret settings without overwriting pending local mutations. */
  refresh(): Promise<void>;
  /** Reload the independent secret channel without writing or broadcasting keys. */
  refreshSecrets(): Promise<void>;
  /**
   * Whether persisted state was read successfully at `init()`. When false the
   * store serves defaults and refuses writes — saving a full snapshot from a
   * map that was never populated would destroy the settings/keys on disk.
   */
  isHydrated(): boolean;
  /** Raw snapshot of the secrets map — used by code that ships API keys as headers. */
  snapshotSecrets(): Record<string, string>;
}
