import { useEffect, useMemo, useReducer, type ReactNode } from "react";
import { setApprovalPluginNames } from "@/lib/approval-message.js";
import {
  getDataService,
  getSessionWorkspace,
  getStorageMode,
} from "@/services/data-service";
import { useBuildSessionActions } from "./session-store/actions.js";
import {
  SessionActionsContext,
  SessionStateContext,
  SessionStructureContext,
  useSession,
  useSessionActions,
  useSessionStructure,
} from "./session-store/context.js";
import {
  useBootEffect,
  useUiSpecHydrationEffect,
  usePersistExecutionStepsEffect,
} from "./session-store/effects.js";
import { initialState, reducer } from "./session-store/reducer.js";
import { useSessionRuntimeRefs } from "./session-store/runtime-refs.js";
import { selectSessionId } from "./session-store/selectors.js";
import { createSseEventHandler } from "./session-store/sse-handler.js";
import { useSessionSubscription } from "./session-store/subscription.js";
import { useExecutionRecovery } from "./session-store/execution-recovery.js";

export type {
  ExecutionStep,
  PendingInteractionDraft,
  StreamMessage,
} from "./session-store/types.js";
export {
  mergeGameStateForReplacement,
  enrichGameStateFromSnapshot,
} from "./session-store/game-state.js";
export { useSession, useSessionActions, useSessionStructure };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const ds = useMemo(() => getDataService(), []);
  const workspace = useMemo(() => getSessionWorkspace(), []);
  const refs = useSessionRuntimeRefs(state);
  const sessionId = selectSessionId(state);

  const handleSseEvent = useMemo(
    () =>
      createSseEventHandler({
        dispatch,
        sessionIdRef: refs.sessionIdRef,
        stateRef: refs.stateRef,
        lastBackfilledTurnIdRef: refs.lastBackfilledTurnIdRef,
      }),
    [ds, refs],
  );

  const actions = useBuildSessionActions({
    state,
    dispatch,
    ds,
    workspace,
    refs,
    handleSseEvent,
  });

  const structure = useMemo(
    () => ({
      session: state.session,
      world: state.world,
      sessionPlugins: state.sessionPlugins,
      gameState: state.gameState,
    }),
    [state.session, state.world, state.sessionPlugins, state.gameState],
  );

  useBootEffect(state, actions.boot);
  useEffect(() => setApprovalPluginNames(state.plugins), [state.plugins]);
  useExecutionRecovery({
    state,
    stateRef: refs.stateRef,
    sessionIdRef: refs.sessionIdRef,
    sessionGenerationRef: refs.sessionGenerationRef,
    dispatch,
    workspace,
  });
  usePersistExecutionStepsEffect(state, ds);
  useUiSpecHydrationEffect(
    sessionId,
    dispatch,
    refs.sessionGenerationRef,
    state.sessionPlugins,
  );
  useSessionSubscription({
    storageMode: getStorageMode(),
    sessionId,
    dispatch,
    workspace,
    sessionIdRef: refs.sessionIdRef,
    stateRef: refs.stateRef,
    activeTurnIdRef: refs.lastBackfilledTurnIdRef,
    sessionGenerationRef: refs.sessionGenerationRef,
    initialEventCursor: state.initialEventCursor,
  });

  // Three providers: actions stay referentially stable, structure updates only
  // on session/plugin/gameState commits (isolating side panels and plugin UIs
  // from per-token SSE churn), and full state serves streaming views.
  return (
    <SessionActionsContext.Provider value={actions}>
      <SessionStructureContext.Provider value={structure}>
        <SessionStateContext.Provider value={state}>
          {children}
        </SessionStateContext.Provider>
      </SessionStructureContext.Provider>
    </SessionActionsContext.Provider>
  );
}

