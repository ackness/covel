import { useEffect } from "react";
import {
  executionMayBeRunning,
  type SessionExecutionStatus,
} from "@covel/shared";
import * as api from "@/services/api.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import {
  enrichGameStateFromSnapshot,
  publishSessionGameState,
} from "./game-state.js";
import { refreshSessionResource } from "./session-resource-reads.js";
import {
  publishRecoveredMessages,
  readRecoveredSnapshot,
} from "./recovered-snapshot.js";
import type { DeltaBufferRef, DeltaRafRef } from "./sse-handler.js";
import { reconcileExecutionSteps } from "./snapshot-execution-steps.js";
import type { MutableRef } from "./runtime-refs.js";
import type { SessionDispatch, SessionState } from "./types.js";

const POLL_INTERVAL_MS = 3000;
const MAX_FAILURE_BACKOFF_MS = 30_000;
/** `unknown` answers in a row before automatic checks stop (about 45s). */
export const MAX_UNKNOWN_CHECKS = 5;

interface RecoveryOptions {
  state: SessionState;
  stateRef: MutableRef<SessionState>;
  sessionIdRef: MutableRef<string | null>;
  sessionGenerationRef: MutableRef<number>;
  deltaBufferRef: DeltaBufferRef;
  deltaRafRef: DeltaRafRef;
  dispatch: SessionDispatch;
  workspace: SessionWorkspace;
}

/** Refreshing an observation never starts another action or LLM call. */
async function refreshRecoveredExecution(
  sessionId: string,
  status: SessionExecutionStatus,
  options: Pick<
    RecoveryOptions,
    "stateRef" | "dispatch" | "workspace" | "deltaBufferRef" | "deltaRafRef"
  >,
  isCurrent: () => boolean,
): Promise<SessionExecutionStatus> {
  if (!executionMayBeRunning(status))
    await options.workspace.hydrate(sessionId);
  if (!isCurrent()) return status;
  let authoritative = status;
  await refreshSessionResource(
    options.dispatch,
    ["game-state", sessionId, "execution-recovery"],
    {
      isCurrent,
      read: (ownsRead) =>
        Promise.all([
          readRecoveredSnapshot(
            sessionId,
            options.stateRef.current.messages,
            ownsRead,
          ),
          api.getSession(sessionId),
        ]),
      apply: ([snapshot, session]) => {
        authoritative = snapshot.execution ?? status;
        options.dispatch({ type: "SET_SESSION", session });
        publishRecoveredMessages(
          options.dispatch,
          options.stateRef.current,
          snapshot,
          authoritative,
          true,
          options.deltaBufferRef,
          options.deltaRafRef,
        );
        publishSessionGameState(
          options.dispatch,
          sessionId,
          enrichGameStateFromSnapshot(snapshot),
        );
        options.dispatch({
          type: "LOAD_EXECUTION_STEPS",
          steps: reconcileExecutionSteps(
            options.stateRef.current.executionSteps,
            snapshot.executionSteps,
            authoritative,
          ),
        });
      },
    },
  );
  return authoritative;
}

export function useExecutionRecovery(options: RecoveryOptions): void {
  const {
    state,
    stateRef,
    sessionIdRef,
    sessionGenerationRef,
    deltaBufferRef,
    deltaRafRef,
    dispatch,
    workspace,
  } = options;
  const sessionGeneration = sessionGenerationRef.current;
  const actionGeneration = state.actionGeneration ?? 0;
  const recovery = state.executionRecovery;
  const sessionId = recovery?.sessionId;
  const hydrating = recovery?.hydrating ?? false;
  const watching =
    !!recovery &&
    !recovery.stalled &&
    (hydrating || recovery.checking || executionMayBeRunning(recovery.status));

  useEffect(() => {
    if (!sessionId || !watching) return;
    let cancelled = false;
    let polling = true;
    let inFlight = false;
    let failureBackoffMs = POLL_INTERVAL_MS;
    let unknownChecks = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () =>
      !cancelled &&
      sessionIdRef.current === sessionId &&
      sessionGenerationRef.current === sessionGeneration &&
      (stateRef.current.actionGeneration ?? 0) === actionGeneration &&
      stateRef.current.executionRecovery?.sessionId === sessionId;
    const hidden = () =>
      typeof document !== "undefined" && document.visibilityState === "hidden";
    const schedule = (delay: number) => {
      if (isCurrent() && polling && !hidden())
        timer = setTimeout(() => {
          timer = undefined;
          void poll();
        }, delay);
    };
    const poll = async () => {
      if (!isCurrent() || !polling || hidden() || inFlight) return;
      inFlight = true;
      try {
        let status = await api.getSessionExecution(sessionId, { retry: false });
        if (!isCurrent() || hidden()) return;
        if (!hydrating) {
          status = await refreshRecoveredExecution(
            sessionId,
            status,
            {
              dispatch,
              stateRef,
              workspace,
              deltaBufferRef,
              deltaRafRef,
            },
            isCurrent,
          );
        }
        if (!isCurrent()) return;
        unknownChecks = status.state === "unknown" ? unknownChecks + 1 : 0;
        // The server could not check: ask again, less often each time, and
        // stop after a few answers so the notice asks the player instead.
        const stalled = unknownChecks >= MAX_UNKNOWN_CHECKS;
        dispatch({
          type: "OBSERVE_EXECUTION_STATUS",
          sessionId,
          status,
          ...(stalled ? { stalled } : {}),
        });
        polling = !stalled && (hydrating || executionMayBeRunning(status));
        if (!polling) return;
        if (unknownChecks > 0) {
          schedule(failureBackoffMs);
          failureBackoffMs = Math.min(
            failureBackoffMs * 2,
            MAX_FAILURE_BACKOFF_MS,
          );
        } else {
          failureBackoffMs = POLL_INTERVAL_MS;
          schedule(POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (!isCurrent()) return;
        dispatch({
          type: "OBSERVE_EXECUTION_STATUS",
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        schedule(failureBackoffMs);
        failureBackoffMs = Math.min(
          failureBackoffMs * 2,
          MAX_FAILURE_BACKOFF_MS,
        );
      } finally {
        inFlight = false;
      }
    };
    const visibilityChanged = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!hidden()) void poll();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [
    sessionId,
    hydrating,
    watching,
    dispatch,
    sessionIdRef,
    stateRef,
    workspace,
    sessionGenerationRef,
    sessionGeneration,
    actionGeneration,
    deltaBufferRef,
    deltaRafRef,
  ]);
}
