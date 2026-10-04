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
  state,
  dispatch,
  runKernelAction,
  resumeSessionById,
}: {
  state: SessionState;
  dispatch: SessionDispatch;
  runKernelAction: (request: api.ActionRequest) => void;
  resumeSessionById: (sessionId: string) => Promise<void>;
}) {
  const retryInterruptedTurn = useCallback(() => {
    const recovery = state.executionRecovery;
    if (!recovery?.status || !state.session || state.executing) return;
    const request = createRecoveryActionRequest(
      recovery.status,
      state.session.id,
    );
    if (request) runKernelAction(request);
  }, [state, runKernelAction]);
  const refreshExecutionRecovery = useCallback(() => {
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
  }, [state, dispatch, resumeSessionById]);
  return { retryInterruptedTurn, refreshExecutionRecovery };
}
