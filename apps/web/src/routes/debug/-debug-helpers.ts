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
  | "flow"
  | "runtime"
  | "llm"
  | "tool"
  | "message"
  | "block"
  | "state"
  | "hook";

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
  label: string;
  status: "running" | "completed" | "failed";
  events: api.TraceEvent[];
  startedAt: string;
  completedAt?: string;
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
    const payload = event.payload;
    const runtimeId = (payload.runtimeId as string) || "";
    if (!runtimeId) continue;

    const pluginId = (payload.pluginId as string) || runtimeId;
    const label = (payload.label as string) || pluginId;

    if (!map.has(runtimeId)) {
      map.set(runtimeId, {
        runtimeId,
        pluginId,
        label,
        status: "running",
        events: [],
        startedAt: event.timestamp,
      });
    }

    const info = map.get(runtimeId)!;
    info.events.push(event);

    if (event.type === "runtime.completed") {
      info.status = "completed";
      info.completedAt = event.timestamp;
    } else if (event.type === "runtime.failed") {
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
    const innerType =
      event.type === "runtime.progress"
        ? (event.payload.type as string) || event.type
        : event.type;

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
      const nextType =
        next.type === "runtime.progress"
          ? (next.payload.type as string) || next.type
          : next.type;
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
  const payload = event.payload;
  const innerType = (payload.type as string) || event.type;

  switch (innerType) {
    case "runtime.started":
      return `${payload.pluginId || ""}${payload.detail && payload.detail !== "[cached]" ? ` - ${payload.detail}` : ""}${payload.detail === "[cached]" ? " (cached)" : ""}`;
    case "runtime.completed":
      return (payload.pluginId as string) || "";
    case "runtime.failed":
      return `${payload.pluginId || ""} - ${payload.detail || "error"}`;
    case "llm.calling": {
      const data = payload.data as Record<string, unknown> | undefined;
      const msgCount = Array.isArray(data?.messages)
        ? (data.messages as unknown[]).length
        : 0;
      return `${payload.detail || ""} ${msgCount > 0 ? `(${msgCount} messages)` : ""}`.trim();
    }
    case "llm.responded": {
      const data = payload.data as Record<string, unknown> | undefined;
      const text = (data?.text as string) || "";
      const toolCalls = Array.isArray(data?.toolCalls)
        ? (data.toolCalls as unknown[]).length
        : 0;
      const usage = data?.usage as
        | { inputTokens?: number; outputTokens?: number }
        | undefined;
      const usageStr = usage
        ? ` [${usage.inputTokens ?? 0}->${usage.outputTokens ?? 0} tok]`
        : "";
      if (toolCalls > 0) return `${toolCalls} tool calls${usageStr}`;
      const preview = text.slice(0, 80);
      return `${preview}${text.length > 80 ? "..." : ""}${usageStr}`;
    }
    case "tool.calling":
      return `${payload.label || ""} ${(payload.detail as string) || ""}`.trim();
    case "tool.completed": {
      const data = payload.data as Record<string, unknown> | undefined;
      const result = data?.result;
      const resultStr =
        typeof result === "string" ? result : JSON.stringify(result ?? "");
      const preview = resultStr.slice(0, 80);
      return `${payload.label || ""} -> ${preview}${resultStr.length > 80 ? "..." : ""}`;
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
    default:
      return "";
  }
}
