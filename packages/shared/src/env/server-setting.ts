import type { ZodType } from "zod";
import type { EnvSource } from "./registry-readers.js";

/** Where the value in force of a server-scoped setting comes from. */
export type ServerSettingSource = "env" | "setting" | "default";

/**
 * A setting the server itself acts on. Its value is kept by the server (one
 * value for every browser of the install), not in a browser's own storage.
 * The Web registry marks the same key with `scope: "server"`.
 */
export interface ServerSettingDefinition<T = unknown> {
  readonly key: string;
  /** What a player may store. */
  readonly schema: ZodType<T>;
  readonly default: T;
  /**
   * The operator's value from the environment, in the terms of the setting,
   * or undefined when the operator set none. It may be a value the schema
   * does not offer to players.
   */
  readonly operatorValue?: (source?: EnvSource) => unknown;
}

export interface ResolvedServerSetting {
  readonly value: unknown;
  readonly source: ServerSettingSource;
}

/** What the server reports about one server-scoped setting. */
export interface ServerSettingInfo extends ResolvedServerSetting {
  /** True when a write of this key would be accepted and take effect. */
  readonly settable: boolean;
}

/** Body of `GET` / `PUT /api/config/server-settings`. */
export interface ServerSettingsSnapshot {
  readonly settings: Readonly<Record<string, ServerSettingInfo>>;
}

/**
 * Precedence: the operator's environment value, then the stored setting, then
 * the default. A stored value the schema refuses counts as not stored.
 *
 * Whether a player's stored value may count at all is the host's decision
 * (the server's host profile: only where one player owns the server). A host
 * that does not let players set these settings passes `undefined`.
 */
export function resolveServerSetting(
  definition: ServerSettingDefinition,
  stored: unknown,
  envSource?: EnvSource,
): ResolvedServerSetting {
  const operator = definition.operatorValue?.(envSource);
  if (operator !== undefined) return { value: operator, source: "env" };
  if (stored !== undefined) {
    const parsed = definition.schema.safeParse(stored);
    if (parsed.success) return { value: parsed.data, source: "setting" };
  }
  return { value: definition.default, source: "default" };
}

/**
 * {@link resolveServerSetting} plus whether a player's write would count.
 * `playerWritable` is the host's answer to "may a player store server-scoped
 * settings here"; where it is false a stored value is ignored.
 */
export function describeServerSetting(
  definition: ServerSettingDefinition,
  stored: unknown,
  playerWritable: boolean,
  envSource?: EnvSource,
): ServerSettingInfo {
  const resolved = resolveServerSetting(
    definition,
    playerWritable ? stored : undefined,
    envSource,
  );
  return {
    ...resolved,
    settable: resolved.source !== "env" && playerWritable,
  };
}
