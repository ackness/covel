/**
 * API Trace routes — read-only endpoints for debug trace inspection.
 */

import { compareText } from "@covel/shared";
import { Hono, type Context } from "hono";
import type { DataStore, TraceEventRecord } from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import { buildSessionDiscoverySnapshot } from "./discovery.js";
import { nextCursorFrom, parseCursorQuery } from "./cursor-params.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { errorBody } from "../../api-error.js";
import { resolveSessionParam } from "./session/session-guard.js";

/** Default per-page event window for the paged turns endpoint. */
const TRACE_PAGE_EVENT_LIMIT = 400;
/**
 * Most events one request to the two unpaged endpoints reads: ten windows of
 * the paged endpoint's maximum. A trace event holds whole prompts, so reading
 * every event of a long session at once is what this bounds.
 */
export const TRACE_FULL_EVENT_LIMIT = 5_000;
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
        compareText(a.timestamp, b.timestamp),
      );
      // A map entry is created with its first event, so `sorted` is never empty.
      const firstEvt = sorted[0]!;
      const lastEvt = sorted.at(-1)!;
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
    .sort((a, b) => compareText(a.startedAt, b.startedAt));
}

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry?: PluginRegistry;
    builtinToolNames?: readonly string[];
  };
};

export const traceRoutes = new Hono<Env>();

/**
 * The newest events of a session, at most {@link TRACE_FULL_EVENT_LIMIT}, or
 * the ones before `?cursor`. `nextCursor` is set when older events remain.
 * The discovery snapshot belongs to the session, so only the first request
 * (no cursor) builds it.
 */
async function readTraceWindow(c: Context<Env>, sessionId: string) {
  const store = c.get("store");
  const cursor = parseCursorQuery(c);
  if (!cursor.ok) return undefined;
  const events = await store.listTraceEventsPage(sessionId, {
    limit: TRACE_FULL_EVENT_LIMIT,
    before: cursor.before,
  });
  const discovery = cursor.before
    ? undefined
    : await buildSessionDiscoverySnapshot({
        isEntryPublished: c.get("isPluginEntryPublished"),
        store,
        registry: c.get("pluginRegistry"),
        sessionId,
        builtinToolNames: c.get("builtinToolNames"),
      });
  return {
    events,
    nextCursor: nextCursorFrom(events, TRACE_FULL_EVENT_LIMIT),
    ...(discovery ? { discovery } : {}),
  };
}

function invalidCursor(c: Context<Env>) {
  return c.json(
    errorBody("Invalid pagination cursor", { code: "invalid_cursor" }),
    400,
  );
}

// GET /:sessionId — the newest trace events of a session, oldest first
traceRoutes.get("/:sessionId", rateLimiter({ max: 120 }), async (c) => {
  const sessionId = c.req.param("sessionId");
  // Traces contain full prompts/LLM output — session-existence + owner guard
  // previously this surface skipped the existence check entirely.
  const guard = await resolveSessionParam(c, "sessionId");
  if (!guard.ok) return guard.response;

  const window = await readTraceWindow(c, sessionId);
  if (!window) return invalidCursor(c);
  const { events, ...rest } = window;
  return c.json({
    sessionId,
    count: events.length,
    ...rest,
    events: toApiTraceEvents(events),
  });
});

// GET /:sessionId/turns — the same window grouped by turn
traceRoutes.get("/:sessionId/turns", rateLimiter({ max: 120 }), async (c) => {
  const sessionId = c.req.param("sessionId");
  const guard = await resolveSessionParam(c, "sessionId");
  if (!guard.ok) return guard.response;

  const window = await readTraceWindow(c, sessionId);
  if (!window) return invalidCursor(c);
  const { events, ...rest } = window;
  return c.json({
    sessionId,
    ...rest,
    turns: buildTurnSummaries(toApiTraceEvents(events)),
  });
});

// GET /:sessionId/turns/page — turns from the most-recent event window. `?limit`
// (events, not turns), `?cursor` (see cursor-params).
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
    const cursor = parseCursorQuery(c, TRACE_PAGE_EVENT_LIMIT);
    if (!cursor.ok) return invalidCursor(c);
    const { limit, before } = cursor;

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
          isEntryPublished: c.get("isPluginEntryPublished"),
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
  const runtimeId = readString(payload, "runtimeId");
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
    const runtimeId = readString(payload, "runtimeId");
    if (!runtimeId) continue;
    const key = runtimeDiagnosticKey(record.turnId, runtimeId);
    const current = contexts.get(key);
    const pluginId = readString(payload, "pluginId");
    const stage = readString(payload, "stage");
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
  contentPath?: "payload.messages";
}

interface TraceToolDiagnostic {
  name?: string;
  callId?: string;
  argumentsAvailable: boolean;
  argumentsPath?: "payload.arguments";
  resultAvailable: boolean;
  resultPath?: "payload.result";
  success?: boolean;
  durationMs?: number;
}

/**
 * Stable, compact fields for debug consumers. The raw payload remains intact
 * for detailed inspection; this summary prevents every client from
 * reverse-engineering event-specific payload shapes just to locate a failure
 * or identify the prompt that was sent.
 */
function buildTraceDiagnostic(
  type: string,
  payload: Record<string, unknown>,
  runtimeContext: RuntimeDiagnosticContext | undefined,
) {
  const displayType = type;
  const runtimeId = readString(payload, "runtimeId");
  const pluginId = readString(payload, "pluginId") ?? runtimeContext?.pluginId;
  const stage = readString(payload, "stage") ?? runtimeContext?.stage;
  const provider = readString(payload, "provider");
  const model = readString(payload, "model");
  const slot = readString(payload, "slot");
  const operation =
    readString(payload, "toolName") ??
    readString(payload, "method") ??
    readString(payload, "hookName");
  const attempt = readNumber(payload, "attempt");
  const durationMs = readNumber(payload, "durationMs");
  const startedAt = readString(payload, "startedAt");
  const error = buildTraceError(displayType, payload);
  const warning = buildSlowWarning(displayType, durationMs, error);
  const tool = buildToolDiagnostic(displayType, payload);
  const prompt = buildPromptDiagnostic(displayType, payload);

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
): TraceToolDiagnostic | undefined {
  if (!displayType.startsWith("tool.")) return undefined;
  const directArgs = hasOwn(payload, "arguments");
  const directResult = hasOwn(payload, "result");
  const name = readString(payload, "toolName");
  const callId = readString(payload, "toolCallId");
  const durationMs = readNumber(payload, "durationMs");
  const success =
    typeof payload.success === "boolean"
      ? payload.success
      : displayType === "tool.completed"
        ? true
        : displayType === "tool.failed"
          ? false
          : undefined;
  return {
    ...(name ? { name } : {}),
    ...(callId ? { callId } : {}),
    argumentsAvailable: directArgs,
    ...(directArgs ? { argumentsPath: "payload.arguments" as const } : {}),
    resultAvailable: directResult,
    ...(directResult ? { resultPath: "payload.result" as const } : {}),
    ...(success == null ? {} : { success }),
    ...(durationMs == null ? {} : { durationMs }),
  };
}

function buildTraceError(
  displayType: string,
  payload: Record<string, unknown>,
): TraceDiagnosticError | undefined {
  const finishReason = readString(payload, "finishReason");
  const isFailure =
    displayType.endsWith(".failed") ||
    displayType === "error.occurred" ||
    displayType === "proposal.failed" ||
    (displayType === "runtime.completed" &&
      readString(payload, "status") === "failed") ||
    (displayType === "turn.completed" && payload.committed === false) ||
    (displayType === "llm.responded" && finishReason === "error");
  if (!isFailure) return undefined;

  const message =
    readString(payload, "error") ??
    readString(payload, "message") ??
    readString(payload, "reason") ??
    readString(payload, "detail") ??
    displayType;
  const code = readString(payload, "code");
  const details = payload.details;

  return {
    message,
    ...(code ? { code } : {}),
    ...(details != null ? { details } : {}),
  };
}

function buildPromptDiagnostic(
  displayType: string,
  payload: Record<string, unknown>,
): TracePromptDiagnostic | undefined {
  if (displayType !== "llm.calling" && displayType !== "gateway.calling") {
    return undefined;
  }

  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : undefined;
  const tools = Array.isArray(payload.tools) ? payload.tools : [];

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
      contentPath: "payload.messages",
    };
  }

  return {
    contentAvailable: false,
    messageCount: readNumber(payload, "messageCount") ?? 0,
    promptChars: readNumber(payload, "promptChars") ?? 0,
    roles: [],
    toolCount: tools.length,
  };
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = payload[key];
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
