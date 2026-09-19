import { z } from "zod";

export const SETTINGS_PERSISTENCE_SCHEMA_VERSION = 2 as const;

export interface SettingsPersistenceBundle {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly savedAt: string;
  readonly entries: Record<string, unknown>;
}

const entriesSchema = z.record(z.string(), z.unknown());
const v2Schema = z
  .object({
    schemaVersion: z.literal(SETTINGS_PERSISTENCE_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    savedAt: z.string(),
    entries: entriesSchema,
  })
  .passthrough();

export function emptySettingsPersistenceBundle(): SettingsPersistenceBundle {
  return {
    schemaVersion: SETTINGS_PERSISTENCE_SCHEMA_VERSION,
    revision: 0,
    savedAt: "",
    entries: {},
  };
}

/** Parse the current persisted settings contract without migrating old data. */
export function parseSettingsPersistenceBundle(
  value: unknown,
): SettingsPersistenceBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings bundle must be an object");
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (version === SETTINGS_PERSISTENCE_SCHEMA_VERSION) {
    const parsed = v2Schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`settings v2 bundle is invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  }
  throw new Error(`unsupported settings schemaVersion: ${String(version)}`);
}

export function nextSettingsPersistenceBundle(
  entries: Record<string, unknown>,
  revision: number,
): SettingsPersistenceBundle {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error("settings revision must be a non-negative integer");
  }
  return {
    schemaVersion: SETTINGS_PERSISTENCE_SCHEMA_VERSION,
    revision: revision + 1,
    savedAt: new Date().toISOString(),
    entries,
  };
}
