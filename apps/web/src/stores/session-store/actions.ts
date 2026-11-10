import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { Seat, SessionPlugin, TurnActionRequest } from "@covel/shared";
import * as api from "@/services/api";
import { ignoreError } from "@/lib/ignore-error.js";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import {
  dropPluginDataSession,
  resetPluginData,
  setActiveSession as setActivePluginDataSession,
} from "@/stores/plugin-data-store.js";
import { invalidateWorldRecord } from "@/services/world-records.js";
import { sessionCharacters } from "@/lib/session-characters.js";
import { bootSessionStore } from "./boot.js";
import {
  composerActions,
  echoedActions,
  textActions,
  type ComposerSubmission,
} from "./composer-actions.js";
import type { SessionActions } from "./context.js";
import { submitInteractionBlock } from "./interaction-submission.js";
import { useExecutionRecoveryActions } from "./execution-recovery-actions.js";
import {
  restoreSessionById,
  restoreSessionState,
  toStreamMessages,
} from "./restore-session.js";
import {
  finalizeActionExecution,
  reportWorkspaceSyncError,
  resumeSessionSuspension,
  runActionStream,
  runSingleSessionAction,
  resyncSessionRecord,
} from "./runtime-rpc.js";
import {
  claimSessionAction,
  type SessionActionOwner,
  type SessionRuntimeRefs,
} from "./runtime-refs.js";
import { canRunSessionAction } from "./selectors.js";
import { useSeatSwitches } from "./seat-switches.js";
import type { SseEventHandler } from "./sse-handler.js";
import { applyResumeEvents as applyResumeSseEvents } from "./sse-handler.js";
import { startGameSession } from "./start-game.js";
import { resolveSetupRuntime as recoverSetupRuntime } from "./setup-recovery-actions.js";
import {
  approveSessionPlugins as approvePausedSessionPlugins,
  loadSessionPlugins as loadSessionPluginList,
  toggleSessionPlugin as toggleSessionPluginState,
} from "./session-plugin-actions.js";
import type {
  PendingInteractionDraft,
  SessionDispatch,
  SessionState,
} from "./types.js";

interface UseSessionActionsOptions {
  state: SessionState;
  dispatch: SessionDispatch;
  ds: DataService;
  workspace: SessionWorkspace;
  refs: SessionRuntimeRefs;
  handleSseEvent: SseEventHandler;
}

/** Page size for the scroll-up "load older messages" fetch. */
const OLDER_MESSAGES_PAGE_SIZE = 40;

export { resyncSessionRecord } from "./runtime-rpc.js";

export function useBuildSessionActions({
  state,
  dispatch,
  ds,
  workspace,
  refs,
  handleSseEvent,
}: UseSessionActionsOptions): SessionActions {
  const { sessionIdRef, sessionGenerationRef, stateRef } = refs;
  const activeActionRef = useRef<symbol | null>(null);
  const admittedInput = useRef<{
    sessionId: string;
    generation: number;
    token: symbol;
    /** Resolves when the admitted action, including its save, settles. */
    settled: Promise<void>;
    /** The page has shown this action executing. */
    started: boolean;
  } | null>(null);
  // `execution.completed` re-enables input while the admitted action is still
  // saving its commit. Once the page has shown it executing and stopped, only
  // that save remains: new input waits for it instead of being dropped.
  useLayoutEffect(() => {
    if (state.executing && admittedInput.current)
      admittedInput.current.started = true;
  }, [state.executing]);
  const pendingAdvanceInput = useRef<{
    sessionId: string;
    generation: number;
    token: symbol;
  } | null>(null);
  const { hasPendingSeatSwitch, settleSeatSwitches, switchSeatCharacter } =
    useSeatSwitches(workspace, dispatch, refs);
  const claimAction = useCallback(
    (sessionId: string, requestId?: string) =>
      claimSessionAction(
        activeActionRef,
        sessionIdRef,
        sessionId,
        requestId,
        sessionGenerationRef,
      ),
    [sessionIdRef, sessionGenerationRef],
  );

  const setAutoAdvanceLimit = useCallback(
    async (autoAdvanceLimit: number) => {
      const sid = sessionIdRef.current;
      const generation = sessionGenerationRef.current;
      if (!sid) return;
      const updated = await ds.updateSession(sid, { autoAdvanceLimit });
      if (
        sessionIdRef.current === sid &&
        sessionGenerationRef.current === generation
      )
        dispatch({ type: "SET_SESSION", session: updated });
    },
    [ds, dispatch, sessionIdRef, sessionGenerationRef],
  );

  const boot = useCallback(async () => {
    await bootSessionStore({ dispatch, ds });
  }, [dispatch, ds]);

  const applyResumeEvents = useCallback(
    (events: api.ResumeSuspensionResponse["events"]) => {
      applyResumeSseEvents(events, handleSseEvent);
    },
    [handleSseEvent],
  );

  const selectWorld = useCallback(
    (worldId: string) => {
      sessionGenerationRef.current += 1;
      sessionIdRef.current = null;
      setActivePluginDataSession(null);
      dispatch({ type: "RESET_SESSION" });
      const world = stateRef.current.worlds.find((item) => item.id === worldId);
      if (world) dispatch({ type: "SET_WORLD", world });
    },
    [dispatch, stateRef, sessionGenerationRef, sessionIdRef],
  );

  const startGame = useCallback(
    async (
      plugins?: string[],
      loreOverride?: string,
      excludedPlugins?: string[],
      seatRole?: import("@covel/shared").SeatRole,
    ) => {
      const world = stateRef.current.world;
      if (!world) return;
      await startGameSession({
        ds,
        workspace,
        dispatch,
        sessionIdRef,
        sessionGenerationRef,
        world,
        plugins,
        loreOverride,
        excludedPlugins,
        seatRole,
      });
    },
    [ds, workspace, dispatch, sessionIdRef, sessionGenerationRef, stateRef],
  );

  const resyncSession = useCallback(
    (sessionId: string, isCurrentAction?: () => boolean): void => {
      if (isCurrentAction && !isCurrentAction()) return;
      void resyncSessionRecord(
        sessionId,
        sessionIdRef,
        dispatch,
        sessionGenerationRef,
        isCurrentAction,
      );
    },
    [dispatch, sessionIdRef, sessionGenerationRef],
  );

  const beginAdventure = useCallback(() => {
    const state = stateRef.current;
    if (!canRunSessionAction(state)) return;
    const sessionId = state.session?.id;
    if (!sessionId) return;
    const owner = claimAction(sessionId);

    if (!owner.isCurrent()) return;
    dispatch({ type: "SET_EXECUTION_RECOVERY", recovery: null });
    dispatch({ type: "SET_EXECUTING", value: true });
    dispatch({ type: "SET_EXECUTION_ERROR", error: null });
    const requestId = owner.requestId;
    void workspace
      .run(sessionId, requestId, () => {
        if (!owner.isCurrent()) {
          return Promise.reject(
            new Error("Session changed before action start"),
          );
        }
        return runActionStream(
          {
            requestId,
            type: "start_session",
            sessionId,
            payload: {},
          },
          handleSseEvent,
          dispatch,
          { sessionIdRef, isCurrentAction: owner.isCurrent },
        );
      })
      .catch((error: unknown) => {
        if (owner.isCurrent()) reportWorkspaceSyncError(error, dispatch);
      })
      .finally(() => {
        finalizeActionExecution(
          dispatch,
          sessionId,
          sessionIdRef,
          owner.isCurrent,
        );
        resyncSession(sessionId, owner.isCurrent);
      });
  }, [
    workspace,
    stateRef,
    handleSseEvent,
    dispatch,
    resyncSession,
    sessionIdRef,
    claimAction,
  ]);

  const resumeSession = useCallback(
    async (session: api.SessionRecord) => {
      await restoreSessionState({
        ds,
        workspace,
        dispatch,
        sessionIdRef,
        sessionGenerationRef,
        worlds: stateRef.current.worlds,
        session,
      });
    },
    [ds, workspace, dispatch, sessionIdRef, sessionGenerationRef, stateRef],
  );

  const resumeSessionById = useCallback(
    async (sessionId: string) => {
      await restoreSessionById({
        ds,
        workspace,
        dispatch,
        sessionIdRef,
        sessionGenerationRef,
        worlds: stateRef.current.worlds,
        sessionId,
      });
    },
    [ds, workspace, dispatch, sessionIdRef, sessionGenerationRef, stateRef],
  );

  const loadWorldSessions = useCallback(async () => {
    const world = stateRef.current.world;
    if (!world) return;
    try {
      const sessions = await ds.listSessions(world.id);
      if (stateRef.current.world?.id !== world.id) return;
      dispatch({ type: "SET_WORLD_SESSIONS", sessions });
    } catch {
      // Non-critical: the picker can retry.
    }
  }, [ds, dispatch, stateRef]);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      await ds.deleteSession(sessionId);
      dropPluginDataSession(sessionId);
      dispatch({ type: "REMOVE_SESSION", sessionId });
    },
    [ds, dispatch],
  );

  const runSingleAction = useCallback(
    (
      actions: readonly TurnActionRequest[],
      opts: {
        echoUserMessage: boolean;
        owner: SessionActionOwner;
        /** Seats a character switch just returned, ahead of the state. */
        seats?: readonly Seat[];
        canDispatch?: () => boolean;
      },
    ): Promise<void> => {
      const { session, gameState, sessionActionKinds } = stateRef.current;
      const { seats, ...rest } = opts;
      return session
        ? runSingleSessionAction({
            actions,
            echoActions: echoedActions(actions, {
              seats: seats ?? session.seats,
              characters: sessionCharacters(gameState),
              catalogue: sessionActionKinds?.kinds,
            }),
            ...rest,
            session,
            workspace,
            dispatch,
            handleSseEvent,
            sessionIdRef,
          })
        : Promise.resolve();
    },
    [workspace, dispatch, stateRef, handleSseEvent, sessionIdRef],
  );

  const startActions = useCallback(
    (
      actions: readonly TurnActionRequest[],
      seats?: readonly Seat[],
      afterAdvance = false,
      isCurrent?: () => boolean,
    ) => {
      const state = stateRef.current;
      if (
        (isCurrent && !isCurrent()) ||
        !state.session ||
        state.session.status !== "active" ||
        (admittedInput.current?.sessionId === state.session.id &&
          admittedInput.current.generation === sessionGenerationRef.current) ||
        (!afterAdvance && !canRunSessionAction(state))
      )
        return false;
      const owner = claimAction(state.session.id);
      const token = Symbol("admitted-input");
      let settle!: () => void;
      admittedInput.current = {
        sessionId: state.session.id,
        generation: sessionGenerationRef.current,
        token,
        settled: new Promise<void>((resolve) => {
          settle = resolve;
        }),
        started: false,
      };

      dispatch({ type: "SET_ADVANCE", advance: null });
      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      runSingleAction(actions, {
        echoUserMessage: true,
        owner,
        canDispatch: isCurrent,
        ...(seats ? { seats } : {}),
      }).finally(() => {
        if (admittedInput.current?.token === token)
          admittedInput.current = null;
        finalizeActionExecution(
          dispatch,
          state.session?.id,
          sessionIdRef,
          owner.isCurrent,
        );
        if (state.session) resyncSession(state.session.id, owner.isCurrent);
        settle();
      });
      return true;
    },
    [
      dispatch,
      stateRef,
      runSingleAction,
      resyncSession,
      sessionIdRef,
      claimAction,
      sessionGenerationRef,
    ],
  );

  // Input the composer already cleared goes back to it when a deferred send
  // cannot start (the session paused or ended meanwhile) or fails.
  const restoreDraft = useCallback(
    (actions: readonly TurnActionRequest[], error?: unknown) => {
      dispatch({
        type: "RESTORE_ACTION_DRAFT",
        requestId: crypto.randomUUID(),
        actions,
      });
      if (error !== undefined)
        dispatch({
          type: "SET_EXECUTION_ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
    },
    [dispatch],
  );

  // A submission waits for a character switch under way: the server acts as
  // the seat's current character, so a request sent first would act as the
  // old one while the bubble named the new one (or the reverse).
  const sendActions = useCallback(
    (actions: readonly TurnActionRequest[], currentOwner?: () => boolean) => {
      if (currentOwner && !currentOwner()) return false;
      const state = stateRef.current;
      // The old stream can finish before its checkpoint does. Keep admission
      // closed until the entire interrupt-and-submit operation has settled.
      if (
        pendingAdvanceInput.current?.sessionId === state.session?.id &&
        pendingAdvanceInput.current?.generation === sessionGenerationRef.current
      )
        return false;
      const advance = state.advance;
      if (
        advance &&
        advance.phase !== "stopped" &&
        state.session?.status === "active"
      ) {
        const sessionId = state.session.id;
        const generation = sessionGenerationRef.current;
        const token = Symbol("advance-input");
        pendingAdvanceInput.current = { sessionId, generation, token };
        const isCurrent = () =>
          sessionIdRef.current === sessionId &&
          sessionGenerationRef.current === generation;
        void (async () => {
          try {
            // Abort is outside the browser workspace FIFO held by the old stream.
            await api.abortTurn(
              sessionId,
              () => isCurrent() && (currentOwner?.() ?? true),
            );
            await workspace.settle?.(sessionId);
            const seats = await settleSeatSwitches(sessionId, generation);
            if (
              isCurrent() &&
              (currentOwner?.() ?? true) &&
              !startActions(actions, seats, true, currentOwner)
            )
              restoreDraft(actions);
          } catch (error) {
            if (isCurrent()) restoreDraft(actions, error);
          } finally {
            if (pendingAdvanceInput.current?.token === token)
              pendingAdvanceInput.current = null;
          }
        })();
        return true;
      }
      const sid = sessionIdRef.current;
      const generation = sessionGenerationRef.current;
      if (!sid) return false;
      const saving = admittedInput.current;
      if (
        saving?.sessionId === sid &&
        saving.generation === generation &&
        saving.started &&
        !state.executing
      ) {
        // The previous action's story is in; only its save is still running.
        const token = Symbol("queued-input");
        pendingAdvanceInput.current = { sessionId: sid, generation, token };
        const isCurrent = () =>
          sessionIdRef.current === sid &&
          sessionGenerationRef.current === generation;
        void saving.settled
          .then(async () => {
            const seats = hasPendingSeatSwitch(sid)
              ? await settleSeatSwitches(sid, generation)
              : undefined;
            if (
              isCurrent() &&
              (currentOwner?.() ?? true) &&
              !startActions(actions, seats, false, currentOwner)
            )
              restoreDraft(actions);
          })
          .catch((error: unknown) => {
            if (isCurrent()) restoreDraft(actions, error);
          })
          .finally(() => {
            if (pendingAdvanceInput.current?.token === token)
              pendingAdvanceInput.current = null;
          });
        return true;
      }
      if (!hasPendingSeatSwitch(sid))
        return startActions(actions, undefined, false, currentOwner);
      const token = Symbol("seat-input");
      pendingAdvanceInput.current = { sessionId: sid, generation, token };
      const isCurrent = () =>
        sessionIdRef.current === sid &&
        sessionGenerationRef.current === generation;
      void settleSeatSwitches(sid, generation)
        .then((seats) => {
          if (
            isCurrent() &&
            (currentOwner?.() ?? true) &&
            !startActions(actions, seats, false, currentOwner)
          )
            restoreDraft(actions);
        })
        .catch((error: unknown) => {
          if (isCurrent()) restoreDraft(actions, error);
        })
        .finally(() => {
          if (pendingAdvanceInput.current?.token === token)
            pendingAdvanceInput.current = null;
        });
      return true;
    },
    [
      startActions,
      restoreDraft,
      sessionIdRef,
      sessionGenerationRef,
      stateRef,
      workspace,
      settleSeatSwitches,
      hasPendingSeatSwitch,
    ],
  );

  const sendMessage = useCallback(
    (content: string) => sendActions(textActions(content)),
    [sendActions],
  );

  const submitComposerAction = useCallback(
    (
      submission: ComposerSubmission,
      opts?: { drafts?: string; isCurrent?: () => boolean },
    ) =>
      sendActions(composerActions(submission, opts?.drafts), opts?.isCurrent),
    [sendActions],
  );

  const steerMessage = useCallback(
    async (content: string): Promise<boolean> => {
      const session = stateRef.current.session;
      if (!session || !content) return false;
      const generation = sessionGenerationRef.current;
      const steered = await api
        .steerTurn(session.id, content)
        .catch(() => null);
      if (
        !steered ||
        sessionIdRef.current !== session.id ||
        sessionGenerationRef.current !== generation
      )
        return false;
      // Echo in the UI. The in-flight action commit captures the authoritative
      // server copy; writing a second local revision here would conflict with
      // that commit. The echo carries the turn that took the message, so the
      // recovery after the turn replaces it with the server's copy and does
      // not add a second row.
      const id = crypto.randomUUID();
      const ts = new Date().toISOString();
      dispatch({
        type: "ADD_STEER_MESSAGE",
        message: {
          id,
          role: "user",
          content,
          timestamp: ts,
          turnId: steered.turnId,
        },
      });
      return true;
    },
    [dispatch, stateRef, sessionIdRef, sessionGenerationRef],
  );

  const abortActiveTurn = useCallback(
    async (options?: { isCurrent?: () => boolean }): Promise<void> => {
      const state = stateRef.current;
      const sid = state.session?.id ?? state.executionRecovery?.sessionId;
      if (sid) await api.abortTurn(sid, options?.isCurrent);
    },
    [stateRef],
  );

  const loadOlderMessages = useCallback(async () => {
    const sid = sessionIdRef.current;
    const generation = sessionGenerationRef.current;
    const cursor = stateRef.current.olderMessagesCursor;
    if (!sid || !cursor) return;
    // A failure propagates so the message list can show it with a retry.
    const page = await ds.listMessagesPage(sid, {
      cursor,
      limit: OLDER_MESSAGES_PAGE_SIZE,
    });
    // A previous visit or an already consumed page cannot rewind history.
    if (
      sessionIdRef.current !== sid ||
      sessionGenerationRef.current !== generation ||
      stateRef.current.olderMessagesCursor !== cursor
    )
      return;
    dispatch({
      type: "PREPEND_MESSAGES",
      messages: toStreamMessages(page.items),
      cursor: page.nextCursor,
    });
  }, [ds, dispatch, sessionIdRef, sessionGenerationRef, stateRef]);

  const submitBlock = useCallback(
    (blockId: string, values?: Record<string, unknown>) => {
      const sid = sessionIdRef.current;
      const owner = stateRef.current.session;
      dispatch({ type: "SUBMIT_BLOCK", blockId, values });
      if (!sid || owner?.id !== sid) return;
      ds.saveSubmittedBlocks(
        sid,
        [blockId],
        values ? { [blockId]: values } : {},
        owner,
      ).catch(ignoreError("save submitted blocks"));
    },
    [ds, dispatch, sessionIdRef, stateRef],
  );

  const submittingInteractions = useRef(new Set<string>());
  const submitInteraction = useCallback<SessionActions["submitInteraction"]>(
    (...submission) =>
      submitInteractionBlock(
        {
          dispatch,
          workspace,
          sessionIdRef,
          handleSseEvent,
          resyncSession,
          inFlight: submittingInteractions.current,
          claimAction,
          stateRef,
        },
        submission,
      ),
    [
      dispatch,
      workspace,
      sessionIdRef,
      handleSseEvent,
      resyncSession,
      claimAction,
      stateRef,
    ],
  );

  const runKernelAction = useCallback(
    (request: api.ActionRequest): void => {
      if (sessionIdRef.current !== request.sessionId) return;
      const owner = claimAction(request.sessionId, request.requestId);
      dispatch({ type: "SET_EXECUTION_RECOVERY", recovery: null });
      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      void workspace
        .run(request.sessionId, request.requestId, () => {
          if (!owner.isCurrent()) {
            return Promise.reject(
              new Error("Session changed before action start"),
            );
          }
          return runActionStream(request, handleSseEvent, dispatch, {
            sessionIdRef,
            isCurrentAction: owner.isCurrent,
          });
        })
        .catch((error: unknown) => {
          if (owner.isCurrent()) reportWorkspaceSyncError(error, dispatch);
        })
        .finally(() => {
          finalizeActionExecution(
            dispatch,
            request.sessionId,
            sessionIdRef,
            owner.isCurrent,
          );
          resyncSession(request.sessionId, owner.isCurrent);
        });
    },
    [
      dispatch,
      workspace,
      handleSseEvent,
      resyncSession,
      sessionIdRef,
      claimAction,
    ],
  );

  const executeCommand = useCallback(
    (command: string) => {
      const state = stateRef.current;
      if (!canRunSessionAction(state)) return;
      const sessionId = state.session?.id;
      if (!sessionId) return;

      runKernelAction({
        requestId: crypto.randomUUID(),
        type: "submit_actions",
        sessionId,
        payload: { actions: [{ kind: "command", text: command }] },
      });
    },
    [stateRef, runKernelAction],
  );

  const { retryInterruptedTurn, refreshExecutionRecovery } =
    useExecutionRecoveryActions({
      stateRef,
      dispatch,
      runKernelAction,
      resumeSessionById,
    });

  const retryRuntime = useCallback(
    (runtimeId?: string | readonly string[], sourceTurnId?: string) => {
      const state = stateRef.current;
      if (!canRunSessionAction(state)) return;
      const sessionId = state.session?.id;
      if (!sessionId) return;
      const recovery = state.executionRecovery?.status;
      if (
        (recovery?.state === "interrupted" || recovery?.state === "failed") &&
        (!sourceTurnId || sourceTurnId === recovery.turnId)
      ) {
        retryInterruptedTurn();
        return;
      }
      if (typeof runtimeId !== "string" && runtimeId !== undefined) {
        if (!sourceTurnId || runtimeId.length === 0) return;
        runKernelAction({
          requestId: crypto.randomUUID(),
          type: "retry_failed_runtimes",
          sessionId,
          payload: {
            runtimeIds: [...new Set(runtimeId)],
            retryFromTurnId: sourceTurnId,
          },
        });
        return;
      }
      if (!runtimeId) return;
      runKernelAction({
        requestId: crypto.randomUUID(),
        type: "retry_runtime",
        sessionId,
        payload: {
          runtimeId,
          ...(sourceTurnId ? { retryFromTurnId: sourceTurnId } : {}),
        },
      });
    },
    [stateRef, runKernelAction, retryInterruptedTurn],
  );

  const resetSession = useCallback(() => {
    sessionGenerationRef.current += 1;
    sessionIdRef.current = null;
    dispatch({ type: "RESET_SESSION" });
    resetPluginData();
  }, [dispatch, sessionGenerationRef, sessionIdRef]);

  const resolveSetupRuntime = useCallback<
    SessionActions["resolveSetupRuntime"]
  >(
    (sessionId, runtimeId, resolution) =>
      sessionIdRef.current === sessionId
        ? recoverSetupRuntime(runtimeId, resolution, {
            workspace,
            sessionIdRef,
            sessionGenerationRef,
            dispatch,
          })
        : Promise.resolve(),
    [workspace, sessionIdRef, sessionGenerationRef, dispatch],
  );

  const backToWorldSelect = useCallback(() => {
    sessionGenerationRef.current += 1;
    sessionIdRef.current = null;
    dispatch({ type: "RESET_TO_WORLD_SELECT" });
    setActivePluginDataSession(null);
  }, [dispatch, sessionGenerationRef, sessionIdRef]);

  const updateWorldLocal = useCallback(
    (world: api.WorldSummary) => {
      invalidateWorldRecord(world.id);
      dispatch({ type: "UPDATE_WORLD", world });
    },
    [dispatch],
  );

  const addWorldLocal = useCallback(
    (world: api.WorldSummary) => {
      invalidateWorldRecord(world.id);
      dispatch({ type: "ADD_WORLD", world });
    },
    [dispatch],
  );

  // The list again, for what changed on the server meanwhile (a world
  // package edited on disk marks its world as having an update).
  const refreshWorlds = useCallback(async () => {
    try {
      dispatch({ type: "SET_WORLDS", worlds: await ds.listWorlds() });
    } catch {
      // The list shown stays; the next refresh or a reload tries again.
    }
  }, [dispatch, ds]);

  const removeWorldLocal = useCallback(
    (worldId: string) => {
      invalidateWorldRecord(worldId);
      dispatch({ type: "REMOVE_WORLD", worldId });
    },
    [dispatch],
  );

  const loadSessionPlugins = useCallback(
    () =>
      loadSessionPluginList({ dispatch, sessionIdRef, sessionGenerationRef }),
    [dispatch, sessionIdRef, sessionGenerationRef],
  );

  const toggleSessionPlugin = useCallback(
    (pluginId: string, enable: boolean) =>
      toggleSessionPluginState(pluginId, enable, {
        dispatch,
        workspace,
        sessionIdRef,
        sessionGenerationRef,
      }),
    [dispatch, workspace, sessionIdRef, sessionGenerationRef],
  );

  const approveSessionPlugins = useCallback(
    (plugins: readonly SessionPlugin[]) =>
      approvePausedSessionPlugins(plugins, {
        dispatch,
        workspace,
        sessionIdRef,
        sessionGenerationRef,
      }),
    [dispatch, workspace, sessionIdRef, sessionGenerationRef],
  );

  // Prompt once per visit for persisted selections whose process-local grant
  // expired. Denial keeps the selection visible for a later explicit retry.
  const approvalVisit = useRef<{ generation: number; attempted: Set<string> }>({
    generation: -1,
    attempted: new Set(),
  });
  useEffect(() => {
    const generation = sessionGenerationRef.current;
    if (approvalVisit.current.generation !== generation) {
      approvalVisit.current = { generation, attempted: new Set() };
    }
    if (!state.session || state.executing) return;
    const pending = state.sessionPlugins.filter(
      (plugin) =>
        plugin.approvalRequired &&
        !approvalVisit.current.attempted.has(plugin.id),
    );
    for (const plugin of pending)
      approvalVisit.current.attempted.add(plugin.id);
    void approveSessionPlugins(pending);
  }, [
    state.session,
    state.sessionPlugins,
    state.executing,
    sessionGenerationRef,
    approveSessionPlugins,
  ]);

  const upsertInteractionDraft = useCallback(
    (draft: PendingInteractionDraft) => {
      dispatch({ type: "UPSERT_DRAFT", draft });
    },
    [dispatch],
  );

  const removeInteractionDraft = useCallback(
    (id: string) => {
      dispatch({ type: "REMOVE_DRAFT", draftId: id });
    },
    [dispatch],
  );

  const clearRestoredInput = useCallback(
    (requestId: string) => {
      dispatch({ type: "CLEAR_RESTORED_INPUT", requestId });
    },
    [dispatch],
  );

  const clearInteractionDrafts = useCallback(() => {
    dispatch({ type: "CLEAR_DRAFTS" });
  }, [dispatch]);

  const resumeSuspension = useCallback(
    async (suspensionId: string, data: unknown) => {
      await resumeSessionSuspension(suspensionId, data, {
        workspace,
        sessionIdRef,
        sessionGenerationRef,
        dispatch,
        applyResumeEvents,
      });
    },
    [
      dispatch,
      workspace,
      sessionIdRef,
      sessionGenerationRef,
      applyResumeEvents,
    ],
  );

  const cancelSuspension = useCallback(
    async (suspensionId: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const generation = sessionGenerationRef.current;
      const isCurrent = () =>
        sessionIdRef.current === sid &&
        sessionGenerationRef.current === generation;
      await workspace.run(sid, `cancel-suspension:${crypto.randomUUID()}`, () =>
        api.cancelSuspension(sid, suspensionId),
      );
      if (!isCurrent()) return;
      dispatch({ type: "REMOVE_SUSPENSION", suspensionId });
      await resyncSessionRecord(
        sid,
        sessionIdRef,
        dispatch,
        sessionGenerationRef,
        isCurrent,
      );
    },
    [dispatch, workspace, sessionIdRef, sessionGenerationRef],
  );

  const refreshSuspensions = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const suspensions = await api.listSuspensions(sid);
      if (sessionIdRef.current !== sid) return;
      dispatch({ type: "SET_SUSPENSIONS", suspensions });
    } catch {
      // Non-critical: suspension support may be unavailable, or network may blip.
    }
  }, [dispatch, sessionIdRef]);

  return useMemo(
    () => ({
      boot,
      setAutoAdvanceLimit,
      selectWorld,
      startGame,
      beginAdventure,
      resumeSession,
      resumeSessionById,
      loadWorldSessions,
      deleteSession,
      sendMessage,
      submitComposerAction,
      switchSeatCharacter,
      steerMessage,
      abortActiveTurn,
      loadOlderMessages,
      submitBlock,
      submitInteraction,
      executeCommand,
      retryRuntime,
      retryInterruptedTurn,
      refreshExecutionRecovery,
      resetSession,
      backToWorldSelect,
      updateWorldLocal,
      refreshWorlds,
      addWorldLocal,
      removeWorldLocal,
      loadSessionPlugins,
      toggleSessionPlugin,
      resolveSetupRuntime,
      upsertInteractionDraft,
      removeInteractionDraft,
      clearInteractionDrafts,
      clearRestoredInput,
      resumeSuspension,
      cancelSuspension,
      refreshSuspensions,
    }),
    [
      boot,
      setAutoAdvanceLimit,
      selectWorld,
      startGame,
      beginAdventure,
      resumeSession,
      resumeSessionById,
      loadWorldSessions,
      deleteSession,
      sendMessage,
      submitComposerAction,
      switchSeatCharacter,
      loadOlderMessages,
      steerMessage,
      abortActiveTurn,
      submitBlock,
      submitInteraction,
      executeCommand,
      retryRuntime,
      retryInterruptedTurn,
      refreshExecutionRecovery,
      resetSession,
      backToWorldSelect,
      updateWorldLocal,
      refreshWorlds,
      addWorldLocal,
      removeWorldLocal,
      loadSessionPlugins,
      toggleSessionPlugin,
      resolveSetupRuntime,
      upsertInteractionDraft,
      removeInteractionDraft,
      clearInteractionDrafts,
      clearRestoredInput,
      resumeSuspension,
      cancelSuspension,
      refreshSuspensions,
    ],
  );
}
