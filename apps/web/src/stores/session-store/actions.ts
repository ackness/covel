import { useCallback, useMemo, useRef } from "react";
import i18n from "i18next";
import * as api from "@/services/api";
import { ignoreError } from "@/lib/ignore-error.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import {
  SessionWorkspaceSyncError,
  type DataService,
  type SessionWorkspace,
} from "@/services/data-service.js";
import {
  resetPluginData,
  setActiveSession as setActivePluginDataSession,
} from "@/stores/plugin-data-store.js";
import { bootSessionStore } from "./boot.js";
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
import type { SseEventHandler } from "./sse-handler.js";
import { applyResumeEvents as applyResumeSseEvents } from "./sse-handler.js";
import { startGameSession } from "./start-game.js";
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
      const world = state.worlds.find((item) => item.id === worldId);
      if (world) dispatch({ type: "SET_WORLD", world });
    },
    [dispatch, state.worlds, sessionGenerationRef, sessionIdRef],
  );

  const startGame = useCallback(
    async (plugins?: string[]) => {
      if (!state.world) return;
      await startGameSession({
        ds,
        workspace,
        dispatch,
        sessionIdRef,
        sessionGenerationRef,
        world: state.world,
        presets: state.presets,
        llmConfig: state.llmConfig,
        plugins,
      });
    },
    [
      ds,
      workspace,
      dispatch,
      sessionIdRef,
      sessionGenerationRef,
      state.world,
      state.presets,
      state.llmConfig,
    ],
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
    if (!canRunSessionAction(state)) return;
    const sessionId = state.session?.id;
    if (!sessionId) return;
    const worldId = state.world?.id ?? "";
    const owner = claimAction(sessionId);

    const postStart = (loreOverride?: unknown) => {
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
              locale: state.session?.locale ?? i18n.language,
              payload: typeof loreOverride === "string" ? { loreOverride } : {},
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
    };

    void api
      .getWorldOverlay(worldId)
      .then((overlay) => postStart(overlay?.lore))
      .catch(() => postStart());
  }, [
    workspace,
    state,
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
        worlds: state.worlds,
        session,
      });
    },
    [ds, workspace, dispatch, sessionIdRef, sessionGenerationRef, state.worlds],
  );

  const resumeSessionById = useCallback(
    async (sessionId: string) => {
      await restoreSessionById({
        ds,
        workspace,
        dispatch,
        sessionIdRef,
        sessionGenerationRef,
        worlds: state.worlds,
        sessionId,
      });
    },
    [ds, workspace, dispatch, sessionIdRef, sessionGenerationRef, state.worlds],
  );

  const loadWorldSessions = useCallback(async () => {
    if (!state.world) return;
    try {
      const sessions = await ds.listSessions(state.world.id);
      dispatch({ type: "SET_WORLD_SESSIONS", sessions });
    } catch {
      // Non-critical: the picker can retry.
    }
  }, [ds, dispatch, state.world]);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      await ds.deleteSession(sessionId);
      dispatch({ type: "REMOVE_SESSION", sessionId });
    },
    [ds, dispatch],
  );

  const runSingleAction = useCallback(
    (
      content: string,
      opts: { echoUserMessage: boolean; owner: SessionActionOwner },
    ): Promise<void> =>
      state.session
        ? runSingleSessionAction({
            content,
            ...opts,
            session: state.session,
            ds,
            workspace,
            dispatch,
            handleSseEvent,
            sessionIdRef,
          })
        : Promise.resolve(),
    [workspace, ds, dispatch, state.session, handleSseEvent, sessionIdRef],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!canRunSessionAction(state) || !state.session) return;
      const owner = claimAction(state.session.id);

      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      runSingleAction(content, { echoUserMessage: true, owner }).finally(() => {
        finalizeActionExecution(
          dispatch,
          state.session?.id,
          sessionIdRef,
          owner.isCurrent,
        );
        if (state.session) resyncSession(state.session.id, owner.isCurrent);
      });
    },
    [
      dispatch,
      state,
      runSingleAction,
      resyncSession,
      sessionIdRef,
      claimAction,
    ],
  );

  const steerMessage = useCallback(
    async (content: string): Promise<boolean> => {
      const session = state.session;
      if (!session || !content) return false;
      const generation = sessionGenerationRef.current;
      const ok = await api.steerTurn(session.id, content).catch(() => false);
      if (
        !ok ||
        sessionIdRef.current !== session.id ||
        sessionGenerationRef.current !== generation
      )
        return false;
      // Echo in the UI. The in-flight action commit captures the authoritative
      // server copy; writing a second local revision here would conflict with
      // that commit.
      const id = crypto.randomUUID();
      const ts = new Date().toISOString();
      dispatch({
        type: "ADD_MESSAGE",
        message: { id, role: "user", content, timestamp: ts },
      });
      return true;
    },
    [dispatch, state.session, sessionIdRef, sessionGenerationRef],
  );

  const abortActiveTurn = useCallback(async (): Promise<void> => {
    const sid = state.session?.id ?? state.executionRecovery?.sessionId;
    if (sid) await api.abortTurn(sid);
  }, [state.session, state.executionRecovery?.sessionId]);

  const loadOlderMessages = useCallback(async () => {
    const sid = sessionIdRef.current;
    // 从 ref 读取最新游标，避免闭包捕获陈旧值并保持该 action 引用稳定。
    const cursor = stateRef.current.olderMessagesCursor;
    if (!sid || !cursor) return;
    try {
      const page = await ds.listMessagesPage(sid, {
        cursor,
        limit: OLDER_MESSAGES_PAGE_SIZE,
      });
      // 会话可能在请求期间被切换 —— 丢弃过期响应。
      if (sessionIdRef.current !== sid) return;
      dispatch({
        type: "PREPEND_MESSAGES",
        messages: toStreamMessages(page.items),
        cursor: page.nextCursor,
      });
    } catch {
      // 非关键：下次滚动到顶部时会重试。
    }
  }, [ds, dispatch, sessionIdRef, stateRef]);

  const submitBlock = useCallback(
    (blockId: string, values?: Record<string, unknown>) => {
      dispatch({ type: "SUBMIT_BLOCK", blockId, values });
      const sid = sessionIdRef.current;
      if (!sid) return;
      ds.saveSubmittedBlocks(
        sid,
        [blockId],
        values ? { [blockId]: values } : {},
      ).catch(ignoreError("save submitted blocks"));
    },
    [ds, dispatch, sessionIdRef],
  );

  const submittingInteractions = useRef(new Set<string>());
  const submitInteraction = useCallback<SessionActions["submitInteraction"]>(
    (...submission) =>
      submitInteractionBlock(
        {
          dispatch,
          workspace,
          sessionIdRef,
          submitBlock,
          runSingleAction,
          resyncSession,
          inFlight: submittingInteractions.current,
          claimAction,
        },
        submission,
      ),
    [
      dispatch,
      workspace,
      sessionIdRef,
      submitBlock,
      runSingleAction,
      resyncSession,
      claimAction,
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
      if (!canRunSessionAction(state)) return;
      const sessionId = state.session?.id;
      if (!sessionId) return;

      runKernelAction({
        requestId: crypto.randomUUID(),
        type: "execute_command",
        sessionId,
        locale: state.session?.locale ?? i18n.language,
        payload: { command },
      });
    },
    [state, runKernelAction],
  );

  const { retryInterruptedTurn, refreshExecutionRecovery } =
    useExecutionRecoveryActions({
      state,
      dispatch,
      runKernelAction,
      resumeSessionById,
    });

  const retryRuntime = useCallback(
    (runtimeId?: string | readonly string[], sourceTurnId?: string) => {
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
          locale: state.session?.locale ?? i18n.language,
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
        locale: state.session?.locale ?? i18n.language,
        payload: {
          runtimeId,
          ...(sourceTurnId ? { retryFromTurnId: sourceTurnId } : {}),
        },
      });
    },
    [state, runKernelAction, retryInterruptedTurn],
  );

  const resetSession = useCallback(() => {
    sessionGenerationRef.current += 1;
    sessionIdRef.current = null;
    dispatch({ type: "RESET_SESSION" });
    resetPluginData();
  }, [dispatch, sessionGenerationRef, sessionIdRef]);

  const backToWorldSelect = useCallback(() => {
    sessionGenerationRef.current += 1;
    sessionIdRef.current = null;
    dispatch({ type: "RESET_TO_WORLD_SELECT" });
    setActivePluginDataSession(null);
  }, [dispatch, sessionGenerationRef, sessionIdRef]);

  const updateWorldLocal = useCallback(
    (world: api.WorldRecord) => {
      dispatch({ type: "UPDATE_WORLD", world });
    },
    [dispatch],
  );

  const addWorldLocal = useCallback(
    (world: api.WorldRecord) => {
      dispatch({ type: "ADD_WORLD", world });
    },
    [dispatch],
  );

  const removeWorldLocal = useCallback(
    (worldId: string) => {
      dispatch({ type: "REMOVE_WORLD", worldId });
    },
    [dispatch],
  );

  const loadSessionPlugins = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const res = await api.listSessionPlugins(sid);
      if (sessionIdRef.current !== sid) return;
      dispatch({
        type: "LOAD_SESSION_PLUGINS",
        plugins: [...res.items],
        commands: [...res.commands],
      });
    } catch {
      // Non-critical: plugins panel is optional.
    }
  }, [dispatch, sessionIdRef]);

  const toggleSessionPlugin = useCallback(
    async (pluginId: string, enable: boolean) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const generation = sessionGenerationRef.current;
      const isCurrent = () =>
        sessionIdRef.current === sid &&
        sessionGenerationRef.current === generation;
      dispatch({ type: "TOGGLE_SESSION_PLUGIN", pluginId, active: enable });
      try {
        if (!enable) {
          await workspace.run(
            sid,
            `plugin-disable:${crypto.randomUUID()}`,
            () => api.disableSessionPlugin(sid, pluginId),
          );
          return;
        }

        const firstResult = await workspace.run(
          sid,
          `plugin-enable:${crypto.randomUUID()}`,
          () => api.enableSessionPlugin(sid, pluginId),
        );
        if (!("status" in firstResult)) return;
        if (firstResult.status !== "approval-required") {
          throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
        }

        // The confirmation dialog must not hold the session workspace FIFO;
        // background checkpoints and other actions remain free to settle while
        // the player decides.
        const approved =
          isCurrent() &&
          (await requestConfirm({
            title: i18n.t("plugin.approval.title"),
            message: i18n.t("plugin.approval.confirmMessage", {
              pluginId: firstResult.pending.pluginId,
              action: firstResult.pending.action,
            }),
            confirmLabel: i18n.t("plugin.approval.allow"),
            cancelLabel: i18n.t("plugin.approval.deny"),
          }));
        if (!approved || !isCurrent()) {
          if (isCurrent()) {
            dispatch({
              type: "TOGGLE_SESSION_PLUGIN",
              pluginId,
              active: false,
            });
          }
          await workspace.run(sid, `plugin-deny:${crypto.randomUUID()}`, () =>
            api.resolveApproval(firstResult.approvalId, "deny", "session", sid),
          );
          return;
        }

        await workspace.run(
          sid,
          `plugin-approve:${crypto.randomUUID()}`,
          async () => {
            // Navigation may happen while this job waits for the workspace.
            if (!isCurrent()) {
              await api.resolveApproval(
                firstResult.approvalId,
                "deny",
                "session",
                sid,
              );
              return;
            }
            await api.resolveApproval(
              firstResult.approvalId,
              "allow",
              "session",
              sid,
            );
            const enabled = await api.enableSessionPlugin(sid, pluginId);
            if ("status" in enabled) {
              throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
            }
          },
        );
      } catch (error) {
        if (!isCurrent()) return;
        if (
          error instanceof SessionWorkspaceSyncError &&
          error.stage === "checkpoint"
        ) {
          reportWorkspaceSyncError(error, dispatch);
          return;
        }
        reportWorkspaceSyncError(error, dispatch);
        dispatch({
          type: "TOGGLE_SESSION_PLUGIN",
          pluginId,
          active: !enable,
        });
      }
    },
    [dispatch, workspace, sessionIdRef, sessionGenerationRef],
  );

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
      await workspace.run(sid, `cancel-suspension:${crypto.randomUUID()}`, () =>
        api.cancelSuspension(sid, suspensionId),
      );
      dispatch({ type: "REMOVE_SUSPENSION", suspensionId });
    },
    [dispatch, workspace, sessionIdRef],
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
      selectWorld,
      startGame,
      beginAdventure,
      resumeSession,
      resumeSessionById,
      loadWorldSessions,
      deleteSession,
      sendMessage,
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
      addWorldLocal,
      removeWorldLocal,
      loadSessionPlugins,
      toggleSessionPlugin,
      upsertInteractionDraft,
      removeInteractionDraft,
      clearInteractionDrafts,
      resumeSuspension,
      cancelSuspension,
      refreshSuspensions,
    }),
    [
      boot,
      selectWorld,
      startGame,
      beginAdventure,
      resumeSession,
      resumeSessionById,
      loadWorldSessions,
      deleteSession,
      sendMessage,
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
      addWorldLocal,
      removeWorldLocal,
      loadSessionPlugins,
      toggleSessionPlugin,
      upsertInteractionDraft,
      removeInteractionDraft,
      clearInteractionDrafts,
      resumeSuspension,
      cancelSuspension,
      refreshSuspensions,
    ],
  );
}
