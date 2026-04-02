import type { ContextProviderInput } from "@covel/plugin-runtime";

// ── Types ───────────────────────────────────────────────────────

interface WorldStateLocation {
  location?: string;
  subLocation?: string;
}

interface WorldStateTime {
  period?: string;
  elapsed?: string;
}

interface WorldStateWeather {
  weather?: string;
  severity?: string;
}

interface WorldState {
  location?: WorldStateLocation;
  time?: WorldStateTime;
  weather?: WorldStateWeather;
}

// ── Context Provider ────────────────────────────────────────────

/**
 * Reads worldState from the current state and formats a readable
 * context block so other runtimes (especially the narrator) have
 * consistent spatial/temporal/environmental awareness.
 */
export async function worldStateContextProvider(
  input: ContextProviderInput
): Promise<{ id: string; title: string; content: string; priority: number }> {
  const isZh = input.locale.startsWith("zh");
  const state = (input.state ?? {}) as Record<string, unknown>;
  const worldState = (state.worldState ?? {}) as WorldState;

  const lines: string[] = [];

  lines.push(isZh ? "## 当前世界状态" : "## Current World State");

  const loc = worldState.location;
  if (loc?.location) {
    const display = loc.subLocation
      ? `${loc.location} - ${loc.subLocation}`
      : loc.location;
    lines.push(isZh ? `- 位置: ${display}` : `- Location: ${display}`);
  } else {
    lines.push(isZh ? "- 位置: 未知" : "- Location: unknown");
  }

  const time = worldState.time;
  if (time?.period) {
    const periodLabel = isZh ? translatePeriod(time.period) : time.period;
    lines.push(isZh ? `- 时间: ${periodLabel}` : `- Time: ${periodLabel}`);
  } else {
    lines.push(isZh ? "- 时间: 未知" : "- Time: unknown");
  }

  const weather = worldState.weather;
  if (weather?.weather) {
    const severityLabel = weather.severity
      ? isZh
        ? ` (${translateSeverity(weather.severity)})`
        : ` (${weather.severity})`
      : "";
    lines.push(
      isZh
        ? `- 天气: ${weather.weather}${severityLabel}`
        : `- Weather: ${weather.weather}${severityLabel}`
    );
  } else {
    lines.push(isZh ? "- 天气: 未知" : "- Weather: unknown");
  }

  return {
    id: "world-state-summary",
    title: isZh ? "世界状态摘要" : "World State Summary",
    content: lines.join("\n"),
    priority: 30,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function translatePeriod(period: string): string {
  const map: Record<string, string> = {
    dawn: "黎明",
    morning: "上午",
    noon: "正午",
    afternoon: "下午",
    dusk: "黄昏",
    evening: "傍晚",
    night: "夜晚",
    midnight: "午夜",
  };
  return map[period] ?? period;
}

function translateSeverity(severity: string): string {
  const map: Record<string, string> = {
    mild: "轻微",
    moderate: "中等",
    severe: "严重",
  };
  return map[severity] ?? severity;
}
