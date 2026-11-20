import type { PageCursor, PluginDetail } from "@covel/shared";
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

export interface TraceDiscovery {
  framework: Record<string, unknown>;
  plugins: PluginDetail[];
  pluginData: PluginDataDiscoveryIndex[];
}

/**
 * The newest events of the session grouped by turn, at most 5000 events.
 * `nextCursor` is set when older events remain; pass it to
 * `fetchTraceTurnsPage` to read them.
 */
export async function fetchTraceTurns(sessionId: string): Promise<{
  sessionId: string;
  discovery?: TraceDiscovery;
  turns: TurnTrace[];
  nextCursor: PageCursor | null;
}> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}/turns`, {
    sessionId,
  });
}

/**
 * Cursor-paginated turn trace fetch: returns the latest event window grouped
 * by `turnId` by default.
 *
 * - `limit` counts events (not turns), defaulting on the server (400, max 500).
 * - Pass the previous page's `nextCursor` as `cursor` to page earlier; one
 *   turn can span window boundaries, so callers merge by `turnId` (see `mergeTurnPages`).
 * - `nextCursor` is `null` once the start of the trace is reached.
 */
export async function fetchTraceTurnsPage(
  sessionId: string,
  opts: { limit?: number; cursor?: PageCursor } = {},
): Promise<{
  sessionId: string;
  turns: TurnTrace[];
  nextCursor: PageCursor | null;
  discovery?: TraceDiscovery;
}> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return request(
    `/api/traces/${encodeURIComponent(sessionId)}/turns/page${qs ? `?${qs}` : ""}`,
    { sessionId },
  );
}
