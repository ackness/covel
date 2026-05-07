import type { ZodType } from "zod";
import type { I18nText } from "../types/world.js";

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
  readonly secret?: boolean;
  readonly visibleWhen?: (store: { get<V>(key: SettingKey): V }) => boolean;
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
  saveSecrets(keys: Record<string, string>): Promise<void>;
}

export type SettingsListener = (value: unknown, key: SettingKey) => void;

export interface SettingsStoreApi {
  get<T>(key: SettingKey): T;
  has(key: SettingKey): boolean;
  list(group?: SettingGroup): readonly SettingEntry[];
  listEntries(): readonly SettingEntry[];
  resolveEntry(key: SettingKey): SettingEntry | null;
  export(opts?: { includeSecrets?: boolean }): Promise<SettingsExportBundle>;
  set<T>(key: SettingKey, value: T): Promise<void>;
  clear(key: SettingKey): Promise<void>;
  clearGroup(group: SettingGroup): Promise<void>;
  clearAll(): Promise<void>;
  import(
    bundle: SettingsExportBundle,
    opts: { keys: readonly SettingKey[]; includeSecrets?: boolean },
  ): Promise<void>;
  subscribe<T>(key: SettingKey, handler: (value: T) => void): () => void;
  subscribeAll(handler: SettingsListener): () => void;
  register<T>(entry: SettingEntry<T>): void;
  unregister(key: SettingKey): void;
  ready(): Promise<void>;
  /** All known secret provider ids (including unregistered ones loaded from disk). */
  listSecretProviders(): readonly string[];
  /** Raw snapshot of the secrets map — used by code that ships API keys as headers. */
  snapshotSecrets(): Record<string, string>;
}
