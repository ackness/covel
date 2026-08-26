import type { I18nText } from "@covel/shared";
import { request } from "./request.js";

// -- Trace API -------------------------------------------------

export interface TraceEvent {
  /** Stable persisted row id. Older servers may omit it. */
  id?: string;
  /** Monotonic position in this API response's chronological event list. */
  eventOrder?: number;
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  /** Event-shape-independent fields intended for debug UIs and API clients. */
  diagnostic?: TraceEventDiagnostic;
  payload: Record<string, unknown>;
}

export interface TraceEventDiagnostic {
  displayType: string;
  severity: "info" | "warning" | "error";
  runtimeId?: string;
  pluginId?: string;
  stage?: string;
  operation?: string;
  provider?: string;
  model?: string;
  slot?: string;
  attempt?: number;
  durationMs?: number;
  /** Actual operation start when the trace row is persisted later. */
  startedAt?: string;
  warning?: { code: "slow"; thresholdMs: number };
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
  prompt?: {
    contentAvailable: boolean;
    messageCount: number;
    promptChars: number;
    roles: string[];
    toolCount: number;
    contentPath?: "payload.messages" | "payload.data.messages";
  };
  tool?: {
    name?: string;
    callId?: string;
    argumentsAvailable: boolean;
    argumentsPath?: "payload.arguments" | "payload.data.arguments";
    resultAvailable: boolean;
    resultPath?: "payload.result" | "payload.data.result";
    success?: boolean;
    durationMs?: number;
  };
}

export interface TurnTrace {
  turnId: string;
  flowId: string;
  traceId: string;
  startedAt: string;
  completedAt: string;
  eventCount: number;
  events: TraceEvent[];
}

export interface PluginDataKeyIndex {
  key: string;
  createdAt: string;
  updatedAt: string;
  valueType: string;
}

export interface PluginDataNamespaceIndex {
  namespace: string;
  count: number;
  latestUpdatedAt?: string;
  keys: PluginDataKeyIndex[];
}

export interface PluginDataDiscoveryIndex {
  pluginId: string;
  namespaces: PluginDataNamespaceIndex[];
}

export interface PluginContract {
  id: string;
  name: I18nText | unknown;
  description?: I18nText | unknown;
  pluginType?: string;
  runtimeCount?: number;
  status?: string;
  source?: string;
  capabilities?: string[];
  declaredPluginDataNamespaces?: string[];
  tools?: {
    builtin?: string[];
    local?: Array<{ runtimeId: string; path: string; name: string }>;
  };
  rpc?: Array<Record<string, unknown>>;
  ui?: {
    right?: Array<{ runtimeId: string; path: string }>;
    message?: Array<{ runtimeId: string; path: string }>;
    left?: Array<{ runtimeId: string; path: string }>;
  };
  runtimes?: Array<Record<string, unknown>>;
  dataSchemas?: Record<string, unknown>;
}

export interface TraceDiscovery {
  framework: Record<string, unknown>;
  plugins: PluginContract[];
  pluginData: PluginDataDiscoveryIndex[];
}

export async function fetchTraceTurns(sessionId: string): Promise<{
  sessionId: string;
  discovery?: TraceDiscovery;
  turns: TurnTrace[];
}> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}/turns`, {
    sessionId,
  });
}

/** 事件游标：定位窗口内最旧一条事件，用于向更早方向翻页。 */
export interface TraceCursor {
  createdAt: string;
  id: string;
}

/**
 * 游标分页拉取 turn 追踪：默认返回「最近一段事件窗口」按 turnId 分组的结果。
 *
 * - `limit` 是**事件**数（非 turn 数），默认由后端决定（400，上限 500）。
 * - `before` 传入上一页的 `nextCursor` 向更早方向翻页；一个 turn 可能跨窗口
 *   边界被切开，调用方需按 turnId 合并（见 `mergeTurnPages`）。
 * - `nextCursor` 为 null 表示已到 trace 起点，没有更早事件。
 */
export async function fetchTraceTurnsPage(
  sessionId: string,
  opts: { limit?: number; before?: TraceCursor } = {},
): Promise<{
  sessionId: string;
  turns: TurnTrace[];
  nextCursor: TraceCursor | null;
  discovery?: TraceDiscovery;
}> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.before) {
    params.set("before_created_at", opts.before.createdAt);
    params.set("before_id", opts.before.id);
  }
  const qs = params.toString();
  return request(
    `/api/traces/${encodeURIComponent(sessionId)}/turns/page${qs ? `?${qs}` : ""}`,
    { sessionId },
  );
}
