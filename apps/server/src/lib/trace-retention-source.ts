import {
  setTraceRetentionPlayerSource,
  TRACE_RETENTION_SETTING_KEY,
  traceRetentionDaysFromSetting,
} from "@covel/shared";
import type { ServerSettings } from "./server-settings.js";

/**
 * Where the player's retention choice reaches the sweep: the server's own
 * settings store. The read is live, so a changed value applies to the next
 * sweep or commit.
 */
export function installTraceRetentionSource(settings: ServerSettings): void {
  setTraceRetentionPlayerSource(() =>
    traceRetentionDaysFromSetting(settings.stored(TRACE_RETENTION_SETTING_KEY)),
  );
}
