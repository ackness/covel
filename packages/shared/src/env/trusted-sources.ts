import { z } from "zod";
import {
  normalizeTrustedSources,
  trustedSourceEntrySchema,
} from "../schemas/trusted-sources.js";
import { readEnvString, type EnvSource } from "./registry-readers.js";
import type { ServerSettingDefinition } from "./server-setting.js";

export const TRUSTED_SOURCES_SETTING_KEY = "trust.sources";
export const trustedSourcesSettingSchema = z
  .array(trustedSourceEntrySchema)
  .max(100)
  .transform(normalizeTrustedSources);
export function trustedSourcesFromEnv(
  source?: EnvSource,
): string[] | undefined {
  const raw = readEnvString("COVEL_TRUSTED_SOURCES", undefined, source);
  if (raw === undefined) return undefined;
  const parsed = trustedSourcesSettingSchema.safeParse(raw.split(","));
  return parsed.success ? parsed.data : undefined;
}
export const TRUSTED_SOURCES_SERVER_SETTING: ServerSettingDefinition<string[]> =
  {
    key: TRUSTED_SOURCES_SETTING_KEY,
    schema: trustedSourcesSettingSchema,
    default: [],
    operatorValue: trustedSourcesFromEnv,
  };
