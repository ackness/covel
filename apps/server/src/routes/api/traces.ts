/**
 * API Trace routes — read-only endpoints for debug trace inspection.
 */

import { Hono } from "hono";
import type { DataStore, TraceEventRecord } from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import { buildSessionDiscoverySnapshot } from "./discovery.js";
import { nextCursorFrom, parseCursorQuery } from "./cursor-params.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { resolveSessionParam } from "./session/session-guard.js";

/** Default per-page event window for the paged turns endpoint. */
const TRACE_PAGE_EVENT_LIMIT = 400;
/** Simple, explainable threshold for slow successful calls/tasks. */
const SLOW_TRACE_WARNING_MS = 1_000;

/**
 * Group a flat, chronologically-ordered event list into per-turn summaries,
 * sorted by first-event time. Turn is the natural page unit — an event-level
 * window can split a turn, so callers page the *events* and let the frontend
 * merge a boundary turn across pages by turnId.
 */
function buildTurnSummaries(events: readonly ApiTraceEvent[]) {
  const turnMap = new Map<string, ApiTraceEvent[]>();
  for (const evt of events) {
    const turnId = evt.turnId || "__unknown__";
    const arr = turnMap.get(turnId);
    if (arr) arr.push(evt);
    else turnMap.set(turnId, [evt]);
  }

  return Array.from(turnMap.entries())
    .map(([turnId, turnEvents]) => {
      const sorted = turnEvents.sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      );
      const firstEvt = sorted[0];
      const lastEvt = sorted[sorted.length - 1];
      const payload = firstEvt.payload;
      const flowId = (payload?.flowId as string) ?? "";
      const traceId = firstEvt.traceId ?? "";

      return {
        turnId,
        flowId,
        traceId,
        startedAt: firstEvt.timestamp,
        completedAt: lastEvt.timestamp,
        eventCount: sorted.length,
        events: sorted,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry?: PluginRegistry;
    builtinToolNames?: readonly string[];
  };
};

export const traceRoutes = new Hono<Env>();

// GET /:sessionId — list all trace events for a session
traceRoutes.get("/:sessionId", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("sessionId");
  // Traces contain full prompts/LLM output — session-existence + owner guard
  // previously this surface skipped the existence check entirely.
  const guard = await resolveSessionParam(c, "sessionId");
  if (!guard.ok) return guard.response;

  const events = await store.listTraceEvents(sessionId);
  const discovery = await buildSessionDiscoverySnapshot({
    store,
    registry: c.get("pluginRegistry"),
    sessionId,
    builtinToolNames: c.get("builtinToolNames"),
  });

  return c.json({
    sessionId,
    count: events.length,
    discovery,
    events: toApiTraceEvents(events),
  });
});

// GET /:sessionId/turns — trace events grouped by turn
traceRoutes.get("/:sessionId/turns", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("sessionId");
  const guard = await resolveSessionParam(c, "sessionId");
  if (!guard.ok) return guard.response;

  const events = await store.listTraceEvents(sessionId);
  const discovery = await buildSessionDiscoverySnapshot({
    store,
    registry: c.get("pluginRegistry"),
    sessionId,
    builtinToolNames: c.get("builtinToolNames"),
  });

  const turns = buildTurnSummaries(toApiTraceEvents(events));

  return c.json({
    sessionId,
    discovery,
    turns,
  });
});

// GET /:sessionId/turns/page — turns from the most-recent event window. `?limit`
// (events, not turns), `?before_created_at`, `?before_id` (see cursor-params).
// nextCursor is the oldest event's position; the frontend merges a turn split
// across the window boundary by turnId when it loads the next (older) page.
traceRoutes.get(
  "/:sessionId/turns/page",
  rateLimiter({ max: 120 }),
  async (c) => {
    const store = c.get("store");
    const sessionId = c.req.param("sessionId");
    const guard = await resolveSessionParam(c, "sessionId");
    if (!guard.ok) return guard.response;
    const { limit, before } = parseCursorQuery(c, TRACE_PAGE_EVENT_LIMIT);

    const events = await store.listTraceEventsPage(sessionId, {
      limit,
      before,
    });
    // Discovery is a session-level snapshot (getSession + N× listPluginData), not
    // per-page — only rebuild it for the first page (no cursor). "Load older"
    // pages reuse the discovery the client already has, avoiding N DB reads per
    // scroll step.
    const discovery = before
      ? undefined
      : await buildSessionDiscoverySnapshot({
          store,
          registry: c.get("pluginRegistry"),
          sessionId,
          builtinToolNames: c.get("builtinToolNames"),
        });

    return c.json({
      sessionId,
      turns: buildTurnSummaries(toApiTraceEvents(events)),
      nextCursor: nextCursorFrom(events, limit),
      ...(discovery ? { discovery } : {}),
    });
  },
);

/**
 * Map a store TraceEventRecord to the shape expected by the frontend API client.
 */
interface RuntimeDiagnosticContext {
  pluginId?: string;
  stage?: string;
}

interface ApiTraceEvent {
  id: string;
  eventOrder: number;
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  diagnostic: ReturnType<typeof buildTraceDiagnostic>;
  payload: Record<string, unknown>;
}

function toApiTraceEvents(records: readonly TraceEventRecord[]) {
  const contexts = buildRuntimeDiagnosticContexts(records);
  return records.map((record, eventOrder) =>
    toApiTraceEvent(record, contexts, eventOrder),
  );
}

function toApiTraceEvent(
  record: TraceEventRecord,
  contexts: ReadonlyMap<string, RuntimeDiagnosticContext>,
  eventOrder: number,
) {
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const legacyData = isRecord(payload.data) ? payload.data : undefined;
  const runtimeId = readString(payload, legacyData, "runtimeId");
  const runtimeContext = runtimeId
    ? contexts.get(runtimeDiagnosticKey(record.turnId, runtimeId))
    : undefined;
  return {
    id: record.id,
    eventOrder,
    type: record.type,
    requestId: (payload.requestId as string) ?? "",
    traceId: record.traceId ?? "",
    sessionId: record.sessionId,
    turnId: record.turnId ?? "",
    flowId: (payload.flowId as string) ?? "",
    seq: (payload.seq as number) ?? 0,
    timestamp: record.createdAt,
    diagnostic: buildTraceDiagnostic(record.type, payload, runtimeContext),
    payload,
  };
}

function buildRuntimeDiagnosticContexts(
  records: readonly TraceEventRecord[],
): Map<string, RuntimeDiagnosticContext> {
  const contexts = new Map<string, RuntimeDiagnosticContext>();
  for (const record of records) {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const legacyData = isRecord(payload.data) ? payload.data : undefined;
    const runtimeId = readString(payload, legacyData, "runtimeId");
    if (!runtimeId) continue;
    const key = runtimeDiagnosticKey(record.turnId, runtimeId);
    const current = contexts.get(key);
    const pluginId = readString(payload, legacyData, "pluginId");
    const stage = readString(payload, legacyData, "stage");
    contexts.set(key, {
      ...(current?.pluginId
        ? { pluginId: current.pluginId }
        : pluginId
          ? { pluginId }
          : {}),
      ...(current?.stage ? { stage: current.stage } : stage ? { stage } : {}),
    });
  }
  return contexts;
}

function runtimeDiagnosticKey(turnId: string, runtimeId: string): string {
  return `${turnId}\u0000${runtimeId}`;
}

type TraceDiagnosticSeverity = "info" | "warning" | "error";

interface TraceDiagnosticWarning {
  code: "slow";
  thresholdMs: number;
}

interface TraceDiagnosticError {
  message: string;
  code?: string;
  details?: unknown;
}

interface TracePromptDiagnostic {
  contentAvailable: boolean;
  messageCount: number;
  promptChars: number;
  roles: string[];
  toolCount: number;
  contentPath?: "payload.messages" | "payload.data.messages";
}

interface TraceToolDiagnostic {
  name?: string;
  callId?: string;
  argumentsAvailable: boolean;
  argumentsPath?: "payload.arguments" | "payload.data.arguments";
  resultAvailable: boolean;
  resultPath?: "payload.result" | "payload.data.result";
  success?: boolean;
  durationMs?: number;
}

/**
 * Stable, compact fields for debug consumers. The raw payload remains intact
 * for backwards compatibility; this summary prevents every client from
 * reverse-engineering event-specific payload shapes just to locate a failure
 * or identify the prompt that was sent.
 */
function buildTraceDiagnostic(
  type: string,
  payload: Record<string, unknown>,
  runtimeContext: RuntimeDiagnosticContext | undefined,
) {
  const legacyData = isRecord(payload.data) ? payload.data : undefined;
  const displayType =
    type === "runtime.progress" && typeof payload.type === "string"
      ? payload.type
      : type;
  const runtimeId = readString(payload, legacyData, "runtimeId");
  const pluginId =
    readString(payload, legacyData, "pluginId") ?? runtimeContext?.pluginId;
  const stage =
    readString(payload, legacyData, "stage") ?? runtimeContext?.stage;
  const provider = readString(payload, legacyData, "provider");
  const model = readString(payload, legacyData, "model");
  const slot = readString(payload, legacyData, "slot");
  const operation =
    readString(payload, legacyData, "toolName") ??
    readString(payload, legacyData, "method") ??
    readString(payload, legacyData, "hookName");
  const attempt = readNumber(payload, legacyData, "attempt");
  const durationMs = readNumber(payload, legacyData, "durationMs");
  const startedAt = readString(payload, legacyData, "startedAt");
  const error = buildTraceError(displayType, payload, legacyData);
  const warning = buildSlowWarning(displayType, durationMs, error);
  const tool = buildToolDiagnostic(displayType, payload, legacyData);
  const prompt = buildPromptDiagnostic(displayType, payload, legacyData);

  return {
    displayType,
    severity: (error
      ? "error"
      : warning
        ? "warning"
        : "info") as TraceDiagnosticSeverity,
    ...(runtimeId ? { runtimeId } : {}),
    ...(pluginId ? { pluginId } : {}),
    ...(stage ? { stage } : {}),
    ...(operation ? { operation } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(slot ? { slot } : {}),
    ...(attempt != null ? { attempt } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(error ? { error } : {}),
    ...(warning ? { warning } : {}),
    ...(tool ? { tool } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function buildSlowWarning(
  displayType: string,
  durationMs: number | undefined,
  error: TraceDiagnosticError | undefined,
): TraceDiagnosticWarning | undefined {
  if (error || durationMs == null || durationMs < SLOW_TRACE_WARNING_MS) {
    return undefined;
  }
  const slowTypes = new Set([
    "llm.responded",
    "gateway.responded",
    "utils.fetch.responded",
    "tool.completed",
    "runtime.completed",
    "function.completed",
  ]);
  return slowTypes.has(displayType)
    ? { code: "slow", thresholdMs: SLOW_TRACE_WARNING_MS }
    : undefined;
}

function buildToolDiagnostic(
  displayType: string,
  payload: Record<string, unknown>,
  legacyData: Record<string, unknown> | undefined,
): TraceToolDiagnostic | undefined {
  if (!displayType.startsWith("tool.")) return undefined;
  const directArgs = hasOwn(payload, "arguments");
  const legacyArgs = !directArgs && hasOwn(legacyData, "arguments");
  const directResult = hasOwn(payload, "result");
  const legacyResult = !directResult && hasOwn(legacyData, "result");
  const name = readString(payload, legacyData, "toolName");
  const callId = readString(payload, legacyData, "toolCallId");
  const durationMs = readNumber(payload, legacyData, "durationMs");
  const success =
    typeof payload.success === "boolean"
      ? payload.success
      : typeof legacyData?.success === "boolean"
        ? legacyData.success
        : displayType === "tool.completed"
          ? true
          : displayType === "tool.failed"
            ? false
            : undefined;
  return {
    ...(name ? { name } : {}),
    ...(callId ? { callId } : {}),
    argumentsAvailable: directArgs || legacyArgs,
    ...(directArgs
      ? { argumentsPath: "payload.arguments" as const }
      : legacyArgs
        ? { argumentsPath: "payload.data.arguments" as const }
        : {}),
    resultAvailable: directResult || legacyResult,
    ...(directResult
      ? { resultPath: "payload.result" as const }
      : legacyResult
        ? { resultPath: "payload.data.result" as const }
        : {}),
    ...(success == null ? {} : { success }),
    ...(durationMs == null ? {} : { durationMs }),
  };
}

function buildTraceError(
  displayType: string,
  payload: Record<string, unknown>,
  legacyData: Record<string, unknown> | undefined,
): TraceDiagnosticError | undefined {
  const finishReason = readString(payload, legacyData, "finishReason");
  const isFailure =
    displayType.endsWith(".failed") ||
    displayType === "error.occurred" ||
    displayType === "proposal.failed" ||
    (displayType === "llm.responded" && finishReason === "error");
  if (!isFailure) return undefined;

  const message =
    readString(payload, legacyData, "error") ??
    readString(payload, legacyData, "message") ??
    readString(payload, legacyData, "reason") ??
    readString(payload, legacyData, "detail") ??
    displayType;
  const code = readString(payload, legacyData, "code");
  const details = payload.details ?? legacyData?.details;

  return {
    message,
    ...(code ? { code } : {}),
    ...(details != null ? { details } : {}),
  };
}

function buildPromptDiagnostic(
  displayType: string,
  payload: Record<string, unknown>,
  legacyData: Record<string, unknown> | undefined,
): TracePromptDiagnostic | undefined {
  if (displayType !== "llm.calling" && displayType !== "gateway.calling") {
    return undefined;
  }

  const directMessages = Array.isArray(payload.messages)
    ? payload.messages
    : undefined;
  const legacyMessages = Array.isArray(legacyData?.messages)
    ? legacyData.messages
    : undefined;
  const messages = directMessages ?? legacyMessages;
  const tools = Array.isArray(payload.tools)
    ? payload.tools
    : Array.isArray(legacyData?.tools)
      ? legacyData.tools
      : [];

  if (messages) {
    const roles: string[] = [];
    let promptChars = 0;
    for (const message of messages) {
      if (!isRecord(message)) continue;
      if (typeof message.role === "string" && !roles.includes(message.role)) {
        roles.push(message.role);
      }
      promptChars += valueLength(message.content);
    }
    return {
      contentAvailable: true,
      messageCount: messages.length,
      promptChars,
      roles,
      toolCount: tools.length,
      contentPath: directMessages
        ? "payload.messages"
        : "payload.data.messages",
    };
  }

  return {
    contentAvailable: false,
    messageCount: readNumber(payload, legacyData, "messageCount") ?? 0,
    promptChars: readNumber(payload, legacyData, "promptChars") ?? 0,
    roles: [],
    toolCount: tools.length,
  };
}

function readString(
  payload: Record<string, unknown>,
  legacyData: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = payload[key] ?? legacyData?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(
  payload: Record<string, unknown>,
  legacyData: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = payload[key] ?? legacyData?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(
  value: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return value != null && Object.prototype.hasOwnProperty.call(value, key);
}

function valueLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value == null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
