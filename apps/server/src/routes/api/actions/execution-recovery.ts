import { z } from "zod";
import type { SessionExecutionStatus, TimeCursor } from "@covel/shared";
import type { DataStore, TraceEventRecord } from "@covel/store";
import { getActiveTurn } from "../turn-control.js";
import type { SessionLock } from "../../../lib/session-lock.js";

const recoveryActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start_session"), payload: z.object({}) }),
  z.object({ type: z.literal("retry_turn"), payload: z.object({}) }),
  z.object({
    type: z.literal("send_message"),
    payload: z.object({ content: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("execute_command"),
    payload: z.object({ command: z.string().min(1) }),
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
 * Foreground actions alone record turn.started. Read backwards in bounded
 * pages until its latest marker is found, including long tool-heavy turns.
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
  let before: TimeCursor | undefined;
  let started: TraceEventRecord | undefined;
  const trailing: TraceEventRecord[] = [];
  while (!started) {
    const page = await store.listTraceEventsPage(sessionId, {
      limit: 200,
      before,
    });
    // Events emitted within the same millisecond use random IDs to break
    // pagination ties. A terminal row can sort before its own start marker.
    trailing.push(...page);
    started = [...page]
      .reverse()
      .find((event) => event.type === "turn.started");
    if (started || page.length < 200) break;
    const oldest = page[0]!;
    before = { createdAt: oldest.createdAt, id: oldest.id };
  }

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
  const results = await store.listTurnResults(sessionId);
  const artifact = results.find((row) => row.turnId === started.turnId);
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
  let retry: SessionExecutionStatus["retry"] = parsed.success
    ? parsed.data
    : undefined;
  if (!retry && !failed) {
    // Legacy opening continuations share a traceId with the committed setup
    // turn from the same HTTP action. A zero player-turn count alone cannot
    // distinguish the opening from the first real (uncommitted) player input.
    const prior = (await store.listTraceEvents(sessionId)).find(
      (event) =>
        event.type === "turn.started" &&
        event.traceId === started.traceId &&
        event.turnId !== started.turnId &&
        results.some(
          (row) =>
            row.turnId === event.turnId && row.commitStatus === "committed",
        ),
    );
    if (prior) {
      retry = { type: "retry_turn", payload: {} };
      identity.origin = "continuation";
    }
  }
  return {
    ...identity,
    state: failed ? "failed" : "interrupted",
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
