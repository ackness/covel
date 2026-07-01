import type { I18nText } from "@covel/shared";
import { request } from "./request.js";

// -- Trace API -------------------------------------------------

export interface TraceEvent {
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
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

export async function fetchTraceEvents(sessionId: string): Promise<{
  sessionId: string;
  count: number;
  discovery?: TraceDiscovery;
  events: TraceEvent[];
}> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}`);
}

export async function fetchTraceTurns(sessionId: string): Promise<{
  sessionId: string;
  turnCount: number;
  discovery?: TraceDiscovery;
  turns: TurnTrace[];
}> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}/turns`);
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
  );
}
