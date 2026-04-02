import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";

// ── Types ───────────────────────────────────────────────────────

interface UpdateLocationInput {
  location: string;
  subLocation?: string;
}

interface AdvanceTimeInput {
  period?: string;
  elapsed?: string;
}

interface SetWeatherInput {
  weather?: string;
  severity?: string;
}

// ── Tool: update-location ───────────────────────────────────────

export async function updateLocationTool(
  ctx: ToolExecutionContext<UpdateLocationInput>
): Promise<ToolExecutionResult> {
  const { location, subLocation } = ctx.input ?? {};

  if (!location) {
    return {
      output: { error: "location is required" },
      proposals: [],
    };
  }

  const locationPatch: Record<string, unknown> = { location };
  if (subLocation) {
    locationPatch.subLocation = subLocation;
  }

  const isZh = ctx.locale.startsWith("zh");
  const displayLocation = subLocation
    ? `${location} - ${subLocation}`
    : location;

  return {
    output: {
      message: isZh
        ? `位置已更新为：${displayLocation}`
        : `Location updated to: ${displayLocation}`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          worldState: {
            location: locationPatch,
          },
        },
      },
      {
        kind: "record.upsert",
        payload: {
          key: "world-state:current",
          recordType: "world_state",
          value: { location: locationPatch },
        },
      },
      {
        kind: "event.emit",
        payload: {
          type: "location_changed",
          data: locationPatch,
        },
      },
    ],
  };
}

// ── Tool: advance-time ──────────────────────────────────────────

const VALID_PERIODS = new Set([
  "dawn",
  "morning",
  "noon",
  "afternoon",
  "dusk",
  "evening",
  "night",
  "midnight",
]);

export async function advanceTimeTool(
  ctx: ToolExecutionContext<AdvanceTimeInput>
): Promise<ToolExecutionResult> {
  const { period, elapsed } = ctx.input ?? {};

  if (period && !VALID_PERIODS.has(period)) {
    return {
      output: {
        error: `Invalid period "${period}". Must be one of: ${[...VALID_PERIODS].join(", ")}`,
      },
      proposals: [],
    };
  }

  const timePatch: Record<string, unknown> = {};
  if (period) {
    timePatch.period = period;
  }
  if (elapsed) {
    timePatch.elapsed = elapsed;
  }

  const isZh = ctx.locale.startsWith("zh");

  return {
    output: {
      message: isZh
        ? `时间已推进${period ? `至${period}` : ""}${elapsed ? `（${elapsed}）` : ""}`
        : `Time advanced${period ? ` to ${period}` : ""}${elapsed ? ` (${elapsed})` : ""}`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          worldState: {
            time: timePatch,
          },
        },
      },
      {
        kind: "record.upsert",
        payload: {
          key: "world-state:current",
          recordType: "world_state",
          value: { time: timePatch },
        },
      },
      {
        kind: "event.emit",
        payload: {
          type: "time_advanced",
          data: timePatch,
        },
      },
    ],
  };
}

// ── Tool: set-weather ───────────────────────────────────────────

const VALID_SEVERITIES = new Set(["mild", "moderate", "severe"]);

export async function setWeatherTool(
  ctx: ToolExecutionContext<SetWeatherInput>
): Promise<ToolExecutionResult> {
  const { weather, severity } = ctx.input ?? {};

  if (severity && !VALID_SEVERITIES.has(severity)) {
    return {
      output: {
        error: `Invalid severity "${severity}". Must be one of: ${[...VALID_SEVERITIES].join(", ")}`,
      },
      proposals: [],
    };
  }

  const weatherPatch: Record<string, unknown> = {};
  if (weather) {
    weatherPatch.weather = weather;
  }
  if (severity) {
    weatherPatch.severity = severity;
  }

  const isZh = ctx.locale.startsWith("zh");

  return {
    output: {
      message: isZh
        ? `天气已设置为：${weather ?? "未知"}${severity ? `（${severity}）` : ""}`
        : `Weather set to: ${weather ?? "unknown"}${severity ? ` (${severity})` : ""}`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          worldState: {
            weather: weatherPatch,
          },
        },
      },
      {
        kind: "record.upsert",
        payload: {
          key: "world-state:current",
          recordType: "world_state",
          value: { weather: weatherPatch },
        },
      },
    ],
  };
}
