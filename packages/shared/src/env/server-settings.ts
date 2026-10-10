import type { ServerSettingDefinition } from "./server-setting.js";
import { TRACE_RETENTION_SERVER_SETTING } from "./trace-retention.js";

/**
 * Every server-scoped setting. The server accepts a write only for a key
 * listed here and only with a value its schema allows.
 */
export const SERVER_SETTINGS: readonly ServerSettingDefinition[] = [
  TRACE_RETENTION_SERVER_SETTING,
];

export function serverSettingDefinition(
  key: string,
): ServerSettingDefinition | undefined {
  return SERVER_SETTINGS.find((definition) => definition.key === key);
}
