import i18n from "@/i18n";
import type * as api from "@/services/api.js";
import {
  Activity,
  Box,
  Database,
  Layers,
  MessageSquare,
  Shield,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type EventCategory =
  "flow" | "runtime" | "llm" | "tool" | "message" | "block" | "state" | "hook";

export function categorize(type: string): EventCategory {
  if (type.startsWith("flow.")) return "flow";
  if (type.startsWith("runtime.")) return "runtime";
  // function.executing / function.completed are function-runtime lifecycle —
  // same lane as runtime.* in the timeline.
  if (type.startsWith("function.")) return "runtime";
  if (type.startsWith("hook.")) return "hook";
  if (type.startsWith("message.")) return "message";
  if (type.startsWith("block.")) return "block";
  if (type.startsWith("state.")) return "state";
  // gateway.* are function-runtime provider calls — group with llm.* so a
  // function runtime's calls surface alongside an agent's LLM calls.
  if (type.startsWith("gateway.")) return "llm";
  // utils.fetch.* are plugin-owned provider HTTP calls (image gen wire) — same
  // provider-call lane as gateway.*/llm.*.
  if (type.startsWith("utils.")) return "llm";
  if (type.startsWith("llm.") || type.includes("llm")) return "llm";
  if (type.includes("tool")) return "tool";
  return "flow";
}

export const CATEGORY_STYLES: Record<
  EventCategory,
  { color: string; bg: string; border: string; icon: LucideIcon }
> = {
  flow: {
    color: "text-zinc-400",
    bg: "bg-zinc-500/10",
    border: "border-zinc-500/20",
    icon: Layers,
  },
  runtime: {
    color: "text-blue-500",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
    icon: Activity,
  },
  llm: {
    color: "text-amber-500",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    icon: Zap,
  },
  tool: {
    color: "text-violet-500",
    bg: "bg-violet-500/10",
    border: "border-violet-500/20",
    icon: Wrench,
  },
  message: {
    color: "text-cyan-500",
    bg: "bg-cyan-500/10",
    border: "border-cyan-500/20",
    icon: MessageSquare,
  },
  block: {
    color: "text-indigo-500",
    bg: "bg-indigo-500/10",
    border: "border-indigo-500/20",
    icon: Box,
  },
  state: {
    color: "text-orange-500",
    bg: "bg-orange-500/10",
    border: "border-orange-500/20",
    icon: Database,
  },
  hook: {
    color: "text-rose-500",
    bg: "bg-rose-500/10",
    border: "border-rose-500/20",
    icon: Shield,
  },
};

export interface RuntimeInfo {
  runtimeId: string;
  pluginId: string;
  stage?: string;
  label: string;
  status: "running" | "completed" | "failed";
  events: api.TraceEvent[];
  startedAt: string;
  completedAt?: string;
}

export function getDisplayType(event: api.TraceEvent): string {
  if (event.diagnostic?.displayType) return event.diagnostic.displayType;
  return event.type === "runtime.progress"
    ? (event.payload.type as string) || event.type
    : event.type;
}

/** Current trace payloads are flat; the fallback keeps old persisted traces readable. */
export function getTraceData(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const legacy = payload.data;
  return typeof legacy === "object" && legacy !== null && !Array.isArray(legacy)
    ? { ...(legacy as Record<string, unknown>), ...payload }
    : payload;
}

export function getTraceError(event: api.TraceEvent):
  | {
      message: string;
      code?: string;
      details?: unknown;
    }
  | undefined {
  if (event.diagnostic?.error) return event.diagnostic.error;
  const type = getDisplayType(event);
  const data = getTraceData(event.payload);
  const isFailure =
    type.endsWith(".failed") ||
    type === "error.occurred" ||
    type === "proposal.failed" ||
    (type === "llm.responded" && data.finishReason === "error");
  if (!isFailure) return undefined;
  const message = [data.error, data.message, data.reason, data.detail].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return {
    message: message ?? type,
    ...(typeof data.code === "string" ? { code: data.code } : {}),
    ...(data.details != null ? { details: data.details } : {}),
  };
}

/** Failures that determine the turn/runtime outcome, excluding recoverable attempts. */
export function isTerminalTraceFailure(event: api.TraceEvent): boolean {
  const type = getDisplayType(event);
  return (
    type === "runtime.failed" ||
    type === "flow.failed" ||
    type === "turn.failed" ||
    type === "proposal.failed" ||
    type === "error.occurred"
  );
}

export function traceEventIdentity(event: api.TraceEvent): string {
  return (
    event.id ??
    `${event.requestId}|${event.traceId}|${event.turnId}|${event.seq}|${event.type}|${event.timestamp}`
  );
}

export interface FmtTimeOptions {
  withMillis?: boolean;
  alwaysDate?: boolean;
}

export function deriveRuntimesFromTurn(
  events: api.TraceEvent[],
): RuntimeInfo[] {
  const map = new Map<string, RuntimeInfo>();

  for (const event of events) {
    const payload = getTraceData(event.payload);
    const runtimeId =
      event.diagnostic?.runtimeId || (payload.runtimeId as string) || "";
    if (!runtimeId) continue;

    const pluginId =
      event.diagnostic?.pluginId || (payload.pluginId as string) || runtimeId;
    const stage =
      event.diagnostic?.stage || (payload.stage as string) || undefined;
    const label = (payload.label as string) || runtimeId;

    if (!map.has(runtimeId)) {
      map.set(runtimeId, {
        runtimeId,
        pluginId,
        ...(stage ? { stage } : {}),
        label,
        status: "running",
        events: [],
        startedAt: event.timestamp,
      });
    }

    const info = map.get(runtimeId)!;
    if (!info.stage && stage) info.stage = stage;
    info.events.push(event);

    const displayType = getDisplayType(event);
    if (displayType === "runtime.completed") {
      info.status = "completed";
      info.completedAt = event.timestamp;
    } else if (displayType === "runtime.failed") {
      info.status = "failed";
      info.completedAt = event.timestamp;
    }
  }

  return Array.from(map.values());
}

export function fmtTime(iso: string, opts: FmtTimeOptions = {}): string {
  const { withMillis = true, alwaysDate = false } = opts;
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    const sameYear = date.getFullYear() === now.getFullYear();

    const locale = i18n.language || "zh-CN";
    const timeOpts: Intl.DateTimeFormatOptions = withMillis
      ? { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : { hour12: false, hour: "2-digit", minute: "2-digit" };
    const time =
      date.toLocaleTimeString(locale, timeOpts) +
      (withMillis ? "." + String(date.getMilliseconds()).padStart(3, "0") : "");

    if (sameDay && !alwaysDate) return time;

    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    if (sameYear) return `${month}-${day} ${time}`;
    return `${date.getFullYear()}-${month}-${day} ${time}`;
  } catch {
    return iso;
  }
}

export function fmtDuration(startIso: string, endIso: string): string {
  try {
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  } catch {
    return "-";
  }
}

export function aggregateDeltas(events: api.TraceEvent[]): api.TraceEvent[] {
  const result: api.TraceEvent[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i];
    const innerType = getDisplayType(event);

    if (innerType !== "message.delta") {
      result.push(event);
      i++;
      continue;
    }

    const runtimeId = event.payload.runtimeId as string;
    let text = String((event.payload.delta as string) || "");
    let count = 1;
    let j = i + 1;

    while (j < events.length) {
      const next = events[j];
      const nextType = getDisplayType(next);
      if (
        nextType !== "message.delta" ||
        (next.payload.runtimeId as string) !== runtimeId
      ) {
        break;
      }
      text += String((next.payload.delta as string) || "");
      count++;
      j++;
    }

    result.push({
      ...event,
      ...(event.diagnostic
        ? {
            diagnostic: {
              ...event.diagnostic,
              displayType: "message.completed",
            },
          }
        : {}),
      payload: {
        ...event.payload,
        type: "message.completed",
        content: text,
        _aggregated: count,
        _originalType: "message.delta",
      },
    });
    i = j;
  }

  return result;
}

export function extractDetail(event: api.TraceEvent): string {
  const payload = getTraceData(event.payload);
  const innerType = getDisplayType(event);
  const error = getTraceError(event);
  if (error) {
    const location =
      event.diagnostic?.runtimeId ||
      (payload.runtimeId as string) ||
      event.diagnostic?.operation ||
      (payload.toolName as string) ||
      "";
    return `${location ? `${location} - ` : ""}${error.code ? `[${error.code}] ` : ""}${error.message}`;
  }

  switch (innerType) {
    case "runtime.started":
      return `${payload.pluginId || ""}${payload.detail && payload.detail !== "[cached]" ? ` - ${payload.detail}` : ""}${payload.detail === "[cached]" ? " (cached)" : ""}`;
    case "runtime.completed":
      return (payload.pluginId as string) || "";
    case "llm.calling": {
      const msgCount = Array.isArray(payload.messages)
        ? payload.messages.length
        : 0;
      const target = [payload.provider, payload.model, payload.slot]
        .filter(Boolean)
        .join(" / ");
      return `${target} ${msgCount > 0 ? `(${msgCount} messages)` : ""}`.trim();
    }
    case "llm.responded": {
      const text = (payload.text as string) || "";
      const toolCalls = Array.isArray(payload.toolCalls)
        ? payload.toolCalls.length
        : 0;
      const usage = payload.usage as
        { inputTokens?: number; outputTokens?: number } | undefined;
      const usageStr = usage
        ? ` [${usage.inputTokens ?? 0}->${usage.outputTokens ?? 0} tok]`
        : "";
      if (toolCalls > 0) return `${toolCalls} tool calls${usageStr}`;
      const preview = text.slice(0, 80);
      return `${preview}${text.length > 80 ? "..." : ""}${usageStr}`;
    }
    case "tool.calling":
      return `${payload.label || payload.toolName || ""} ${formatPreview(payload.arguments)}`.trim();
    case "tool.completed": {
      const result = payload.result ?? payload.parsedResult;
      const resultStr =
        typeof result === "string" ? result : JSON.stringify(result ?? "");
      const preview = resultStr.slice(0, 80);
      return `${payload.label || payload.toolName || ""} -> ${preview}${resultStr.length > 80 ? "..." : ""}`;
    }
    case "message.delta":
      return `${payload.runtimeId || ""} +${String((payload.delta as string) || "").length} chars`;
    case "message.completed": {
      const content = (payload.content as string) || "";
      const aggregated = payload._aggregated as number | undefined;
      const prefix = aggregated
        ? `${payload.runtimeId || ""} ${content.length} chars (${aggregated} deltas) - `
        : "";
      const preview = content.slice(0, 80);
      return `${prefix}${preview}${content.length > 80 ? "..." : ""}`;
    }
    case "block.emitted": {
      const block = payload.block as Record<string, unknown> | undefined;
      return block ? `type: ${block.type || "unknown"}` : "";
    }
    case "state.patch.applied": {
      const patch = payload.patch as Record<string, unknown> | undefined;
      return patch ? `${patch.packageName || ""} - ${patch.summary || ""}` : "";
    }
    case "flow.completed":
      return payload.retry
        ? `retry from ${payload.retryFromRuntimeId || "all"}`
        : "";
    case "flow.failed":
      return (payload.message as string) || "";
    case "gateway.calling":
      return `${payload.method || ""} (${payload.messageCount || 0} messages, ${payload.promptChars || 0} chars)`;
    default:
      return "";
  }
}

function formatPreview(value: unknown): string {
  if (value == null) return "";
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value) ?? String(value));
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}
