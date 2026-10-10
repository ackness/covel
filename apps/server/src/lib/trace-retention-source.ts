import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  currentTraceRetention,
  readRuntimeEnv,
  setTraceRetentionPlayerSource,
  TRACE_RETENTION_SETTING_KEY,
  traceRetentionDaysFromSetting,
  type TraceRetentionSource,
} from "@covel/shared";
import { parseSettingsPersistenceBundle } from "@covel/shared/settings-persistence";

/**
 * Where the player's retention choice reaches the server: the desktop
 * `settings.json` in the Covel home, the file the SettingsStore writes. A
 * browser keeps its settings in localStorage, which the server cannot read, so
 * there only the environment and the default apply.
 */
function settingsFile(): string | null {
  const env = readRuntimeEnv();
  if (!env.desktopRest || env.deploymentTier !== "self") return null;
  const home = env.covelHome ?? join(homedir(), ".covel");
  return join(home, "settings.json");
}

let cache: { key: string; days: number | undefined } | undefined;

/** The player's day count, or undefined when unset, unreadable or not stored. */
export function readPlayerTraceRetentionDays(): number | undefined {
  const file = settingsFile();
  if (!file || !existsSync(file)) return undefined;
  const stat = statSync(file);
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (cache?.key === key) return cache.days;
  let days: number | undefined;
  try {
    const bundle = parseSettingsPersistenceBundle(
      JSON.parse(readFileSync(file, "utf-8")) as unknown,
    );
    days = traceRetentionDaysFromSetting(
      bundle.entries[TRACE_RETENTION_SETTING_KEY],
    );
  } catch {
    // An unreadable file is the settings API's problem; retention falls back.
    days = undefined;
  }
  cache = { key, days };
  return days;
}

/** Register the settings file as the player source for the retention in force. */
export function installTraceRetentionSource(): void {
  setTraceRetentionPlayerSource(readPlayerTraceRetentionDays);
}

export interface TraceRetentionInfo {
  readonly days: number;
  readonly source: TraceRetentionSource;
  /** True when a player's choice would take effect on this server. */
  readonly settable: boolean;
}

export function traceRetentionInfo(): TraceRetentionInfo {
  const { days, source } = currentTraceRetention();
  return {
    days,
    source,
    settable: source !== "env" && settingsFile() !== null,
  };
}
