import { useMemo, useReducer, type ReactNode } from "react";
import { getDataService } from "@/services/data-service";
import { useBuildSessionActions } from "./session-store/actions.js";
import {
  SessionActionsContext,
  SessionStateContext,
  useSession,
  useSessionActions,
  useSessionState,
} from "./session-store/context.js";
import {
  useBootEffect,
  useMessageUiSpecHydrationEffect,
  usePersistExecutionStepsEffect,
} from "./session-store/effects.js";
import { initialState, reducer } from "./session-store/reducer.js";
import { useSessionRuntimeRefs } from "./session-store/runtime-refs.js";
import { selectSessionId } from "./session-store/selectors.js";
import { createSseEventHandler } from "./session-store/sse-handler.js";
import { useSessionSubscription } from "./session-store/subscription.js";

export type {
  AssetProgressEvent,
  ExecutionStep,
  PendingInteractionDraft,
  StreamMessage,
  SuspensionRecord,
} from "./session-store/types.js";
export {
  mergeGameStateForReplacement,
  enrichGameStateFromSnapshot,
} from "./session-store/game-state.js";
export { useSession, useSessionActions, useSessionState };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const ds = useMemo(() => getDataService(), []);
  const refs = useSessionRuntimeRefs(state);
  const sessionId = selectSessionId(state);

  const handleSseEvent = useMemo(
    () =>
      createSseEventHandler({
        dispatch,
        ds,
        sessionIdRef: refs.sessionIdRef,
        stateRef: refs.stateRef,
        runtimeKindRef: refs.runtimeKindRef,
        deltaBufferRef: refs.deltaBufferRef,
        deltaRafRef: refs.deltaRafRef,
        lastBackfilledTurnIdRef: refs.lastBackfilledTurnIdRef,
      }),
    [ds, refs],
  );

  const actions = useBuildSessionActions({
    state,
    dispatch,
    ds,
    refs,
    handleSseEvent,
  });

  useBootEffect(state, actions.boot);
  usePersistExecutionStepsEffect(state, ds);
  useMessageUiSpecHydrationEffect(sessionId, dispatch);
  useSessionSubscription({
    sessionId,
    dispatch,
    sessionIdRef: refs.sessionIdRef,
  });

  // Two providers: the actions value is referentially stable across streaming
  // state changes (useBuildSessionActions memoises it), so action-only
  // consumers via useSessionActions() never re-render on delta updates. Only
  // useSessionState() / useSession() consumers track the high-frequency state.
  return (
    <SessionActionsContext.Provider value={actions}>
      <SessionStateContext.Provider value={state}>
        {children}
      </SessionStateContext.Provider>
    </SessionActionsContext.Provider>
  );
}
