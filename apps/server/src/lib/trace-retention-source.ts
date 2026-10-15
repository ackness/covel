import {
  setTraceRetentionPlayerSource,
  TRACE_RETENTION_SETTING_KEY,
  traceRetentionDaysFromSetting,
} from "@covel/shared";
import type { ServerSettings } from "./server-settings.js";

/**
 * Where the player's retention choice reaches the sweep: the server's own
 * settings store. The read is live, so a changed value applies to the next
 * sweep or commit. Where the host profile gives players no say (a hosted
 * tier), no source is installed and only the operator's value and the default
 * apply.
 */
export function installTraceRetentionSource(settings: ServerSettings): void {
  setTraceRetentionPlayerSource(
    settings.playerWritable
      ? () =>
          traceRetentionDaysFromSetting(
            settings.stored(TRACE_RETENTION_SETTING_KEY),
          )
      : undefined,
  );
}
