import {
  readEnvString,
  readRuntimeEnv,
  type EnvSource,
} from "./registry-readers.js";

/** Days a trace event is kept when neither the operator nor the player chose. */
export const DEFAULT_TRACE_RETENTION_DAYS = 30;

/** SettingsStore key of the player's choice. */
export const TRACE_RETENTION_SETTING_KEY = "diagnostics.traceRetention";

/** What the setting stores: a day count as text, or `keep` for no deletion. */
export const TRACE_RETENTION_SETTING_VALUES = [
  "7",
  "30",
  "90",
  "keep",
] as const;

export type TraceRetentionSource = "env" | "setting" | "default";

export interface TraceRetention {
  /** Days a trace is kept; `0` keeps everything. */
  readonly days: number;
  readonly source: TraceRetentionSource;
}

/** The day count a stored setting value stands for, or undefined if invalid. */
export function traceRetentionDaysFromSetting(
  value: unknown,
): number | undefined {
  if (value === "keep") return 0;
  if (typeof value !== "string") return undefined;
  return (TRACE_RETENTION_SETTING_VALUES as readonly string[]).includes(value)
    ? Number(value)
    : undefined;
}

function operatorDays(source: EnvSource | undefined): number | undefined {
  const raw = readEnvString("COVEL_TRACE_RETENTION_DAYS", undefined, source);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Precedence: the operator's `COVEL_TRACE_RETENTION_DAYS`, then the player's
 * setting, then {@link DEFAULT_TRACE_RETENTION_DAYS}. A hosted tier ignores the
 * player's value: retention there belongs to the operator.
 */
export function resolveTraceRetention(
  playerDays?: number,
  envSource?: EnvSource,
): TraceRetention {
  const operator = operatorDays(envSource);
  if (operator !== undefined) return { days: operator, source: "env" };
  const hosted = readRuntimeEnv(envSource).deploymentTier !== "self";
  if (!hosted && playerDays !== undefined) {
    return { days: playerDays, source: "setting" };
  }
  return { days: DEFAULT_TRACE_RETENTION_DAYS, source: "default" };
}

let playerSource: (() => number | undefined) | undefined;

/**
 * The host registers where the player's choice lives (the server reads the
 * desktop `settings.json`). Without a source only the environment and the
 * default apply.
 */
export function setTraceRetentionPlayerSource(
  source: (() => number | undefined) | undefined,
): void {
  playerSource = source;
}

/** Retention in force now; cheap enough to call after every commit. */
export function currentTraceRetention(): TraceRetention {
  let player: number | undefined;
  try {
    player = playerSource?.();
  } catch {
    player = undefined;
  }
  return resolveTraceRetention(player);
}
