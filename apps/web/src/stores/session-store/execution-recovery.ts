import { useEffect } from "react";
import type { SessionExecutionStatus } from "@covel/shared";
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
  if (status.state !== "running") await options.workspace.hydrate(sessionId);
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
    (hydrating || recovery.checking || recovery.status?.state === "running");

  useEffect(() => {
    if (!sessionId || !watching) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () =>
      !cancelled &&
      sessionIdRef.current === sessionId &&
      sessionGenerationRef.current === sessionGeneration &&
      (stateRef.current.actionGeneration ?? 0) === actionGeneration &&
      stateRef.current.executionRecovery?.sessionId === sessionId;
    const poll = async () => {
      try {
        let status = await api.getSessionExecution(sessionId);
        if (!isCurrent()) return;
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
        dispatch({
          type: "SET_EXECUTION_RECOVERY",
          recovery: {
            sessionId,
            status,
            hydrating,
            checking: false,
            ...(hydrating && stateRef.current.executionRecovery?.error
              ? { error: stateRef.current.executionRecovery.error }
              : {}),
          },
        });
        if (hydrating || status.state === "running")
          timer = setTimeout(() => void poll(), 3000);
      } catch (error) {
        if (!isCurrent()) return;
        dispatch({
          type: "SET_EXECUTION_RECOVERY",
          recovery: {
            sessionId,
            status: stateRef.current.executionRecovery?.status ?? null,
            hydrating,
            checking: true,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
