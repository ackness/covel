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

/**
 * Why this build cannot use a stored bundle, as the label a host puts in the
 * name of the copy it keeps: `v1` for an earlier format, `unversioned` for
 * one without a version, `damaged` for text that is not a bundle. Undefined
 * for a bundle this build reads, and for one a later build wrote: that build
 * still needs it where it is.
 *
 * A store that fails to load refuses every write, so such a bundle leaves the
 * player with read-only defaults and no way out. A host moves it aside under
 * a name with this label, and the settings start from their defaults.
 */
export function unusableSettingsBundleLabel(raw: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "damaged";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "damaged";
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (version === undefined) return "unversioned";
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 0
  ) {
    return "damaged";
  }
  if (version > SETTINGS_PERSISTENCE_SCHEMA_VERSION) return undefined;
  if (version < SETTINGS_PERSISTENCE_SCHEMA_VERSION) return `v${version}`;
  return v2Schema.safeParse(value).success ? undefined : "damaged";
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
