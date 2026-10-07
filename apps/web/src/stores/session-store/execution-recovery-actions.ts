import type { MutableRef } from "./runtime-refs.js";
import { useCallback } from "react";
import {
  actionRequestSchema,
  type SessionExecutionStatus,
} from "@covel/shared";
import type * as api from "@/services/api.js";
import type { SessionDispatch, SessionState } from "./types.js";

export function createRecoveryActionRequest(
  status: SessionExecutionStatus,
  sessionId: string,
): api.ActionRequest | undefined {
  if (
    !status.retry ||
    !status.turnId ||
    !["interrupted", "failed"].includes(status.state)
  )
    return;
  return actionRequestSchema.parse({
    requestId: crypto.randomUUID(),
    sessionId,
    type: status.retry.type,
    payload: { ...status.retry.payload, recoverFromTurnId: status.turnId },
  });
}

export function useExecutionRecoveryActions({
  stateRef,
  dispatch,
  runKernelAction,
  resumeSessionById,
}: {
  stateRef: MutableRef<SessionState>;
  dispatch: SessionDispatch;
  runKernelAction: (request: api.ActionRequest) => void;
  resumeSessionById: (sessionId: string) => Promise<void>;
}) {
  const retryInterruptedTurn = useCallback(() => {
    const state = stateRef.current;
    const recovery = state.executionRecovery;
    if (!recovery?.status || !state.session || state.executing) return;
    const request = createRecoveryActionRequest(
      recovery.status,
      state.session.id,
    );
    if (request) runKernelAction(request);
  }, [stateRef, runKernelAction]);
  const refreshExecutionRecovery = useCallback(() => {
    const state = stateRef.current;
    const recovery = state.executionRecovery;
    if (!recovery) return;
    if (!state.session && recovery.error) {
      void resumeSessionById(recovery.sessionId).catch(() => {});
      return;
    }
    dispatch({
      type: "SET_EXECUTION_RECOVERY",
      recovery: { ...recovery, checking: true, error: undefined },
    });
  }, [stateRef, dispatch, resumeSessionById]);
  return { retryInterruptedTurn, refreshExecutionRecovery };
}
