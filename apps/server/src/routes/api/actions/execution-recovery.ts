import { z } from "zod";
import type { SessionExecutionStatus } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { getActiveTurn } from "../turn-control.js";
import type { SessionLock } from "../../../lib/session-lock.js";

const recoveryActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start_session"), payload: z.object({}) }),
  z.object({ type: z.literal("retry_turn"), payload: z.object({}) }),
  z.object({
    type: z.literal("send_message"),
    payload: z.object({
      content: z.string().min(1),
      inputMessageId: z.string().min(1).optional(),
    }),
  }),
  z.object({
    type: z.literal("execute_command"),
    payload: z.object({
      command: z.string().min(1),
      inputMessageId: z.string().min(1).optional(),
    }),
  }),
  z.object({
    type: z.literal("retry_failed_runtimes"),
    payload: z.object({
      retryFromTurnId: z.string().min(1),
      runtimeIds: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .refine((ids) => new Set(ids).size === ids.length)
        .transform((ids) => [...ids].sort()),
    }),
  }),
  z.object({
    type: z.literal("retry_runtime"),
    payload: z.object({
      runtimeId: z.string().min(1),
      retryFromTurnId: z.string().optional(),
    }),
  }),
]);

/** Persist only the action input needed to retry, never request headers. */
export function recoveryAction(
  type: string,
  payload: unknown,
  continuation = false,
): SessionExecutionStatus["retry"] {
  if (continuation) return { type: "retry_turn", payload: {} };
  const parsed = recoveryActionSchema.safeParse({ type, payload });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Foreground actions alone record turn.started. Read the latest marker and
 * only its terminal events, including long tool-heavy turns.
 * This does not acquire the session lock: a refresh must observe a running
 * turn without waiting for its LLM or final transaction to finish.
 */
export async function getSessionExecutionStatus(
  store: DataStore,
  sessionId: string,
  lock?: SessionLock,
): Promise<SessionExecutionStatus> {
  const active = getActiveTurn(sessionId);
  if (active) return { state: "running", ...active };
  if (lock?.tryWithLock) {
    const result = await lock.tryWithLock(sessionId, () =>
      readExecutionStatus(store, sessionId),
    );
    return result.acquired ? result.value : { state: "running" };
  }
  const result = await readExecutionStatus(store, sessionId);
  const newlyActive = getActiveTurn(sessionId);
  return newlyActive ? { state: "running", ...newlyActive } : result;
}

async function readExecutionStatus(
  store: DataStore,
  sessionId: string,
): Promise<SessionExecutionStatus> {
  const [started] = await store.queryTraceEvents(sessionId, {
    types: ["turn.started"],
    newestFirst: true,
    limit: 1,
  });
  const trailing = started
    ? await store.queryTraceEvents(sessionId, {
        turnId: started.turnId,
        types: ["turn.completed", "turn.failed"],
      })
    : [];

  // An action may have acquired the lock while the trace query was in flight.
  const newlyActive = getActiveTurn(sessionId);
  if (newlyActive) return { state: "running", ...newlyActive };
  if (!started) return { state: "idle" };

  const payload = (started.payload ?? {}) as Record<string, unknown>;
  const identity: {
    turnId: string;
    startedAt: string;
    origin?: SessionExecutionStatus["origin"];
    requestId?: string;
  } = {
    turnId: started.turnId,
    startedAt: started.createdAt,
    ...(payload.origin === "player" || payload.origin === "continuation"
      ? { origin: payload.origin }
      : {}),
    ...(typeof payload.requestId === "string"
      ? { requestId: payload.requestId }
      : {}),
  };
  const terminal = trailing.find(
    (event) =>
      event.turnId === started.turnId && event.type === "turn.completed",
  );
  const terminalPayload = terminal?.payload as
    Record<string, unknown> | undefined;
  if (terminalPayload?.committed === true)
    return { ...identity, state: "completed" };

  // The transaction may have committed immediately before the process died,
  // leaving no terminal trace. Durable business state takes precedence.
  const [artifact] = await store.queryTurnResults(sessionId, {
    turnId: started.turnId,
    limit: 1,
  });
  if (
    artifact?.commitStatus === "committed" ||
    (terminal && !artifact && terminalPayload?.committed !== false)
  ) {
    return { ...identity, state: "completed" };
  }
  const failed =
    terminalPayload?.committed === false ||
    artifact?.commitStatus === "failed" ||
    trailing.some(
      (event) =>
        event.turnId === started.turnId && event.type === "turn.failed",
    );
  const parsed = recoveryActionSchema.safeParse(payload.recoveryAction);
  const retry: SessionExecutionStatus["retry"] = parsed.success
    ? parsed.data
    : undefined;
  return {
    ...identity,
    state: failed ? "failed" : "interrupted",
    ...(typeof terminalPayload?.abortReason === "string"
      ? { abortReason: terminalPayload.abortReason }
      : {}),
    ...(retry ? { retry } : {}),
  };
}

/** Rechecked inside the session lock so two retry clicks cannot both run. */
export async function assertRecoverableTurn(
  store: DataStore,
  sessionId: string,
  turnId: unknown,
  action?: { type: string; payload: unknown },
): Promise<SessionExecutionStatus | undefined> {
  if (turnId === undefined) return;
  const status = await getSessionExecutionStatus(store, sessionId);
  if (
    typeof turnId !== "string" ||
    status.turnId !== turnId ||
    !status.retry ||
    (action &&
      JSON.stringify(recoveryAction(action.type, action.payload)) !==
        JSON.stringify(status.retry)) ||
    (status.state !== "interrupted" && status.state !== "failed")
  ) {
    throw new Error(
      "The previous turn is no longer available for recovery. Refresh its status before retrying.",
    );
  }
  return status;
}
