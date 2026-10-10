import { useCallback, useEffect, useMemo, useRef } from "react";
import i18n from "i18next";
import type { SessionPlugin } from "@covel/shared";
import * as api from "@/services/api";
import { ignoreError } from "@/lib/ignore-error.js";
import { requestChoices, requestConfirm } from "@/lib/confirm-channel.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  SessionWorkspaceSyncError,
  type DataService,
  type SessionWorkspace,
} from "@/services/data-service.js";
import {
  dropPluginDataSession,
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
import { refreshSessionResource } from "./session-resource-reads.js";
import { canRunSessionAction } from "./selectors.js";
import type { SseEventHandler } from "./sse-handler.js";
import { applyResumeEvents as applyResumeSseEvents } from "./sse-handler.js";
import { startGameSession } from "./start-game.js";
import { resolveSetupRuntime as recoverSetupRuntime } from "./setup-recovery-actions.js";
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
      content: string,
      opts: { echoUserMessage: boolean; owner: SessionActionOwner },
    ): Promise<void> => {
      const session = stateRef.current.session;
      return session
        ? runSingleSessionAction({
            content,
            ...opts,
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

  const sendMessage = useCallback(
    (content: string) => {
      const state = stateRef.current;
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
      stateRef,
      runSingleAction,
      resyncSession,
      sessionIdRef,
      claimAction,
    ],
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
        type: "ADD_MESSAGE",
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

  const abortActiveTurn = useCallback(async (): Promise<void> => {
    const state = stateRef.current;
    const sid = state.session?.id ?? state.executionRecovery?.sessionId;
    if (sid) await api.abortTurn(sid);
  }, [stateRef]);

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
          submitBlock,
          runSingleAction,
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
      submitBlock,
      runSingleAction,
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
        type: "execute_command",
        sessionId,
        payload: { command },
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
    const generation = sessionGenerationRef.current;
    try {
      await refreshSessionResource(dispatch, ["plugins", sid], {
        isCurrent: () =>
          sessionIdRef.current === sid &&
          sessionGenerationRef.current === generation,
        read: () => api.listSessionPlugins(sid),
        apply: (res) =>
          dispatch({
            type: "LOAD_SESSION_PLUGINS",
            plugins: [...res.items],
            commands: [...res.commands],
          }),
      });
    } catch {
      // Non-critical: plugins panel is optional.
    }
  }, [dispatch, sessionIdRef, sessionGenerationRef]);

  const toggleSessionPlugin = useCallback(
    async (pluginId: string, enable: boolean) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const generation = sessionGenerationRef.current;
      const isCurrent = () =>
        sessionIdRef.current === sid &&
        sessionGenerationRef.current === generation;
      // UI specs are fetched when active plugins change. Publish that change
      // only after the server mutation, so panels cannot cache the old specs.
      const applyActive = () => {
        if (isCurrent()) {
          dispatch({ type: "TOGGLE_SESSION_PLUGIN", pluginId, active: enable });
        }
      };
      try {
        if (!enable) {
          await workspace.run(
            sid,
            `plugin-disable:${crypto.randomUUID()}`,
            async () => {
              const result = await api.disableSessionPlugin(sid, pluginId);
              applyActive();
              return result;
            },
          );
          return;
        }

        const firstResult = await workspace.run(
          sid,
          `plugin-enable:${crypto.randomUUID()}`,
          async () => {
            const result = await api.enableSessionPlugin(sid, pluginId);
            if (!("status" in result)) applyActive();
            return result;
          },
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
            applyActive();
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
      }
    },
    [dispatch, workspace, sessionIdRef, sessionGenerationRef],
  );

  /**
   * Authorize several paused community plugins with one prompt that names each
   * of them, instead of one prompt per plugin. Every plugin still gets its own
   * approval request and its own grant; only the question is asked once.
   *
   * The prompt comes first and the approval requests after it, one plugin at a
   * time. Enabling a plugin makes the server drop the pending approvals of the
   * session's other paused plugins, so requests gathered up front would be
   * gone by the time the second one is answered. Asking first also leaves no
   * request behind for a plugin the player unticked.
   */
  const approveSessionPlugins = useCallback(
    async (plugins: readonly SessionPlugin[]) => {
      const sid = sessionIdRef.current;
      if (!sid || plugins.length === 0) return;
      const generation = sessionGenerationRef.current;
      const isCurrent = () =>
        sessionIdRef.current === sid &&
        sessionGenerationRef.current === generation;

      const allowed = await requestChoices({
        title: i18n.t("plugin.approval.batchTitle"),
        message: i18n.t("plugin.approval.batchMessage"),
        confirmLabel: i18n.t("plugin.approval.allowSelected"),
        cancelLabel: i18n.t("plugin.approval.notNow"),
        choices: plugins.map((plugin) => {
          const label =
            resolveDisplayText(plugin.displayName, i18n.language) || plugin.id;
          return {
            id: plugin.id,
            label,
            detail: [
              // The id is the label already when the plugin has no name.
              [label === plugin.id ? "" : plugin.id, plugin.version]
                .filter(Boolean)
                .join(" · "),
              resolveDisplayText(plugin.description, i18n.language),
            ]
              .filter(Boolean)
              .join(" — "),
          };
        }),
      });

      for (const plugin of plugins) {
        if (!allowed.includes(plugin.id)) continue;
        try {
          await workspace.run(
            sid,
            `plugin-approve:${crypto.randomUUID()}`,
            async () => {
              // Navigation may happen while this job waits for the workspace.
              if (!isCurrent()) return;
              const activate = () => {
                if (isCurrent())
                  dispatch({
                    type: "TOGGLE_SESSION_PLUGIN",
                    pluginId: plugin.id,
                    active: true,
                  });
              };
              const first = await api.enableSessionPlugin(sid, plugin.id);
              if (!("status" in first)) return activate();
              if (first.status !== "approval-required")
                throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
              // The player consented to this plugin by name. A request about
              // anything else is refused rather than granted under it.
              if (first.pending.pluginId !== plugin.id || !isCurrent()) {
                await api.resolveApproval(
                  first.approvalId,
                  "deny",
                  "session",
                  sid,
                );
                return;
              }
              await api.resolveApproval(
                first.approvalId,
                "allow",
                "session",
                sid,
              );
              const enabled = await api.enableSessionPlugin(sid, plugin.id);
              if ("status" in enabled)
                throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
              activate();
            },
          );
        } catch (error) {
          // One plugin failing must not stop the others the player allowed.
          if (isCurrent()) reportWorkspaceSyncError(error, dispatch);
        }
      }
    },
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
      resolveSetupRuntime,
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
      addWorldLocal,
      removeWorldLocal,
      loadSessionPlugins,
      toggleSessionPlugin,
      resolveSetupRuntime,
      upsertInteractionDraft,
      removeInteractionDraft,
      clearInteractionDrafts,
      resumeSuspension,
      cancelSuspension,
      refreshSuspensions,
    ],
  );
}
