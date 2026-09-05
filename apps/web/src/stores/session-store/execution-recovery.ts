import { useEffect } from "react";
import type { SessionExecutionStatus } from "@covel/shared";
import * as api from "@/services/api.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import { toStreamMessages } from "./restore-session.js";
import { reconcileExecutionSteps } from "./snapshot-execution-steps.js";
import type { MutableRef } from "./runtime-refs.js";
import type { SessionDispatch, SessionState } from "./types.js";

interface RecoveryOptions {
  state: SessionState;
  stateRef: MutableRef<SessionState>;
  sessionIdRef: MutableRef<string | null>;
  dispatch: SessionDispatch;
  workspace: SessionWorkspace;
}

/** Refreshing an observation never starts another action or LLM call. */
export async function refreshRecoveredExecution(
  sessionId: string,
  status: SessionExecutionStatus,
  options: Pick<RecoveryOptions, "stateRef" | "dispatch" | "workspace">,
  isCurrent: () => boolean,
): Promise<SessionExecutionStatus> {
  if (status.state !== "running") await options.workspace.hydrate(sessionId);
  if (!isCurrent()) return status;
  const [snapshot, session] = await Promise.all([
    api.getSessionView(sessionId),
    api.getSession(sessionId),
  ]);
  if (!isCurrent()) return status;
  const authoritative = snapshot.execution ?? status;
  options.dispatch({ type: "SET_SESSION", session });
  options.dispatch({
    type: "MERGE_RECOVERED_MESSAGES",
    messages: toStreamMessages(snapshot.messages),
  });
  options.dispatch({
    type: "SET_GAME_STATE",
    state: enrichGameStateFromSnapshot(snapshot),
  });
  options.dispatch({
    type: "LOAD_EXECUTION_STEPS",
    steps: reconcileExecutionSteps(
      options.stateRef.current.executionSteps,
      snapshot.executionSteps,
      authoritative,
    ),
  });
  return authoritative;
}

export function useExecutionRecovery(options: RecoveryOptions): void {
  const { state, stateRef, sessionIdRef, dispatch, workspace } = options;
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
  ]);
}
