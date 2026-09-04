import { useCallback, useMemo } from "react";
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
import { clearStreamingTextsForTurn } from "@/stores/streaming-text-store.js";
import { bootSessionStore } from "./boot.js";
import type { SessionActions } from "./context.js";
import { toExecutionStepStatus } from "./execution-steps.js";
import { enrichGameStateFromSnapshot } from "./game-state.js";
import { restoreSessionState, toStreamMessages } from "./restore-session.js";
import {
  finalizeActionExecution,
  reportWorkspaceSyncError,
  runActionStream,
} from "./runtime-rpc.js";
import type { MutableRef, SessionRuntimeRefs } from "./runtime-refs.js";
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

/**
 * The server evolves SessionRecord during a turn (the phase/clock advances,
 * pre-game completion, status) but the SSE stream carries none of it —
 * without a resync the stage view's phase gate stays stale until a
 * full page reload.
 */
export async function resyncSessionRecord(
  sessionId: string,
  sessionIdRef: MutableRef<string | null>,
  dispatch: SessionDispatch,
): Promise<void> {
  try {
    const session = await api.getSession(sessionId);
    // A stale response after a session switch must not overwrite the
    // now-active session's record (and yank the URL back to it).
    if (sessionIdRef.current !== sessionId) return;
    dispatch({ type: "SET_SESSION", session });
  } catch {
    /* next action or reload will resync */
  }
}

export function useBuildSessionActions({
  state,
  dispatch,
  ds,
  workspace,
  refs,
  handleSseEvent,
}: UseSessionActionsOptions): SessionActions {
  const { sessionIdRef, stateRef } = refs;

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
      dispatch({ type: "RESET_SESSION" });
      const world = state.worlds.find((item) => item.id === worldId);
      if (world) dispatch({ type: "SET_WORLD", world });
    },
    [dispatch, state.worlds],
  );

  const startGame = useCallback(
    async (plugins?: string[]) => {
      if (!state.world) return;
      await startGameSession({
        ds,
        workspace,
        dispatch,
        sessionIdRef,
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
      state.world,
      state.presets,
      state.llmConfig,
    ],
  );

  const resyncSession = useCallback(
    (sessionId: string): void => {
      void resyncSessionRecord(sessionId, sessionIdRef, dispatch);
    },
    [dispatch, sessionIdRef],
  );

  const beginAdventure = useCallback(() => {
    if (!canRunSessionAction(state)) return;
    const sessionId = state.session?.id;
    if (!sessionId) return;
    const worldId = state.world?.id ?? "";

    const postStart = (loreOverride?: unknown) => {
      if (sessionIdRef.current !== sessionId) return;
      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });
      const requestId = crypto.randomUUID();
      void workspace
        .run(sessionId, requestId, () => {
          if (sessionIdRef.current !== sessionId) {
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
            { sessionIdRef },
          );
        })
        .catch((error: unknown) => {
          reportWorkspaceSyncError(error, dispatch);
        })
        .finally(() => {
          finalizeActionExecution(dispatch, sessionId, sessionIdRef);
          resyncSession(sessionId);
        });
    };

    void api
      .getWorldOverlay(worldId)
      .then((overlay) => postStart(overlay?.lore))
      .catch(() => postStart());
  }, [workspace, state, handleSseEvent, dispatch, resyncSession, sessionIdRef]);

  const resumeSession = useCallback(
    async (session: api.SessionRecord) => {
      await restoreSessionState({
        ds,
        workspace,
        dispatch,
        sessionIdRef,
        worlds: state.worlds,
        session,
      });
    },
    [ds, workspace, dispatch, sessionIdRef, state.worlds],
  );

  const resumeSessionById = useCallback(
    async (sessionId: string) => {
      const session = await ds.getSession(sessionId);
      if (!session) throw new Error("Session not found: " + sessionId);
      await resumeSession(session);
    },
    [ds, resumeSession],
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
    (content: string, opts: { echoUserMessage: boolean }): Promise<void> => {
      const session = state.session;
      if (!session) return Promise.resolve();
      const sessionId = session.id;

      let persistInput: Promise<void> = Promise.resolve();
      if (opts.echoUserMessage && content) {
        const userMsgId = crypto.randomUUID();
        const userTimestamp = new Date().toISOString();
        dispatch({
          type: "ADD_MESSAGE",
          message: {
            id: userMsgId,
            role: "user",
            content,
            timestamp: userTimestamp,
          },
        });
        persistInput = ds.addMessage({
          id: userMsgId,
          sessionId,
          role: "user",
          content,
          createdAt: userTimestamp,
        });
      }

      return new Promise<void>((resolve) => {
        const fireAction = () => {
          const isCommand = content.startsWith("/");
          const requestId = crypto.randomUUID();
          return workspace.run(sessionId, requestId, () => {
            if (sessionIdRef.current !== sessionId) {
              return Promise.reject(
                new Error("Session changed before action start"),
              );
            }
            const action: api.ActionRequest = isCommand
              ? {
                  requestId,
                  type: "execute_command",
                  sessionId,
                  locale: session.locale ?? i18n.language,
                  payload: { command: content },
                }
              : {
                  requestId,
                  type: "send_message",
                  sessionId,
                  locale: session.locale ?? i18n.language,
                  payload: { content },
                };
            return runActionStream(action, handleSseEvent, dispatch, {
              toastOnError: true,
              sessionIdRef,
            });
          });
        };

        // Settle the promise on an aborted sync too, or `sendMessage`'s
        // `.finally(finalizeActionExecution)` never runs and the UI stays
        // stuck on "executing".
        persistInput.then(
          () =>
            fireAction().then(resolve, (error: unknown) => {
              reportWorkspaceSyncError(error, dispatch);
              resolve();
            }),
          (error: unknown) => {
            ignoreError("persist user message")(error);
            resolve();
          },
        );
      });
    },
    [workspace, ds, dispatch, state.session, handleSseEvent],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!canRunSessionAction(state)) return;

      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      runSingleAction(content, { echoUserMessage: true }).finally(() => {
        finalizeActionExecution(dispatch, state.session?.id, sessionIdRef);
        if (state.session) resyncSession(state.session.id);
      });
    },
    [dispatch, state, runSingleAction, resyncSession],
  );

  const steerMessage = useCallback(
    async (content: string): Promise<boolean> => {
      const session = state.session;
      if (!session || !content) return false;
      const ok = await api.steerTurn(session.id, content).catch(() => false);
      if (!ok) return false;
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
    [ds, dispatch, state.session],
  );

  const abortActiveTurn = useCallback(async (): Promise<void> => {
    const session = state.session;
    if (!session) return;
    await api.abortTurn(session.id).catch(() => false);
  }, [state.session]);

  const loadOlderMessages = useCallback(async () => {
    const sid = sessionIdRef.current;
    // 从 ref 读取最新游标，避免闭包捕获陈旧值并保持该 action 引用稳定。
    const cursor = stateRef.current.olderMessagesCursor;
    if (!sid || !cursor) return;
    try {
      const page = await ds.listMessagesPage(sid, {
        before: { createdAt: cursor.createdAt, id: cursor.id },
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
      ds.loadSubmittedBlocks(sid)
        .then(({ ids, values: existingValues }) => {
          const nextIds = ids.includes(blockId) ? ids : [...ids, blockId];
          const nextValues = values
            ? { ...existingValues, [blockId]: values }
            : existingValues;
          ds.saveSubmittedBlocks(sid, nextIds, nextValues).catch(
            ignoreError("save submitted blocks"),
          );
        })
        .catch(ignoreError("load submitted blocks for update"));
    },
    [ds, dispatch, sessionIdRef],
  );

  const submitInteraction = useCallback(
    async (
      blockId: string,
      turnId: string,
      interactionId: string,
      type: "form" | "choice" | "confirmation",
      values: Record<string, unknown>,
      submitBehavior?: { echoFilledNarrative?: boolean },
    ) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const echo = submitBehavior?.echoFilledNarrative !== false;

      // Persist the player's input and fill the interaction template. If this
      // fails we cannot run the turn, so fall back to a plain message so the
      // player's input is never silently dropped.
      let filled: string;
      try {
        submitBlock(blockId, values);
        const result = await workspace.run(
          sid,
          `interaction:${crypto.randomUUID()}`,
          () =>
            api.submitInputs(sid, {
              turnId,
              submissions: [{ interactionId, type, values }],
            }),
        );
        filled = result.results?.[0]?.filledNarrative ?? "";
      } catch (err) {
        if (sessionIdRef.current !== sid) return;
        if (reportWorkspaceSyncError(err, dispatch)) return;
        console.error("[submitInteraction] submit-form failed:", err);
        sendMessage(Object.values(values).join(", "));
        return;
      }

      // Run the resulting narrative turn, then re-sync the character snapshot.
      //
      // Proposal-backed character writes (including the builtin
      // create/update-character tools and player-init guard) emit
      // `character.upserted`, so characters update incrementally.
      // `characterSchema` still has no SSE carrier; refresh the snapshot after
      // setup input so the schema and character slices are reconciled together.
      //
      // So after the turn that may have created/updated the player, we pull a
      // snapshot to refresh both `characters` and `characterSchema`. Done after
      // the turn (not before) so a just-created character is included.
      if (sessionIdRef.current !== sid) return;
      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });
      try {
        await runSingleAction(echo ? filled : "", {
          echoUserMessage: echo && Boolean(filled),
        });
        try {
          const snapshot = await api.getSessionSnapshot(sid);
          if (sessionIdRef.current === sid) {
            dispatch({
              type: "SET_GAME_STATE",
              state: enrichGameStateFromSnapshot(snapshot),
            });
          }
        } catch {
          // Non-critical: the character panel refreshes on reconnect/restore.
        }
      } finally {
        finalizeActionExecution(dispatch, sid, sessionIdRef);
        const currentSid = sessionIdRef.current;
        if (currentSid) resyncSession(currentSid);
      }
    },
    [
      dispatch,
      sessionIdRef,
      submitBlock,
      sendMessage,
      runSingleAction,
      resyncSession,
    ],
  );

  const runKernelAction = useCallback(
    (request: api.ActionRequest): void => {
      if (sessionIdRef.current !== request.sessionId) return;
      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      void workspace
        .run(request.sessionId, request.requestId, () => {
          if (sessionIdRef.current !== request.sessionId) {
            return Promise.reject(
              new Error("Session changed before action start"),
            );
          }
          return runActionStream(request, handleSseEvent, dispatch, {
            sessionIdRef,
          });
        })
        .catch((error: unknown) => {
          reportWorkspaceSyncError(error, dispatch);
        })
        .finally(() => {
          finalizeActionExecution(dispatch, request.sessionId, sessionIdRef);
          if (request.sessionId) resyncSession(request.sessionId);
        });
    },
    [dispatch, workspace, handleSseEvent, resyncSession, sessionIdRef],
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

  const retryRuntime = useCallback(
    (runtimeId?: string, sourceTurnId?: string) => {
      if (!canRunSessionAction(state)) return;
      const sessionId = state.session?.id;
      if (!sessionId) return;

      // Whole-turn retry regenerates the narrative, so the turn's messages
      // go. A chip-scoped retry (sourceTurnId set) replays ONE auxiliary
      // runtime against that turn's recorded outputs — the narrative stays.
      const lastTurnId =
        state.messages.length > 0
          ? [...state.messages].reverse().find((message) => message.turnId)
              ?.turnId
          : undefined;
      if (lastTurnId && !sourceTurnId) {
        clearStreamingTextsForTurn(lastTurnId);
        dispatch({
          type: "REMOVE_MESSAGES_FROM_TURN",
          turnId: lastTurnId,
          keepRuntimeIds: new Set<string>(),
        });
      }

      const requestId = crypto.randomUUID();
      runKernelAction(
        runtimeId
          ? {
              requestId,
              type: "retry_runtime",
              sessionId,
              locale: state.session?.locale ?? i18n.language,
              payload: {
                runtimeId,
                ...(sourceTurnId ? { retryFromTurnId: sourceTurnId } : {}),
              },
            }
          : {
              requestId,
              type: "retry_turn",
              sessionId,
              locale: state.session?.locale ?? i18n.language,
              payload: {},
            },
      );
    },
    [dispatch, state, runKernelAction],
  );

  const resetSession = useCallback(() => {
    dispatch({ type: "RESET_SESSION" });
    resetPluginData();
  }, [dispatch]);

  const backToWorldSelect = useCallback(() => {
    dispatch({ type: "RESET_TO_WORLD_SELECT" });
    setActivePluginDataSession(null);
  }, [dispatch]);

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
        plugins: res.available,
        commands: res.commands,
      });
    } catch {
      // Non-critical: plugins panel is optional.
    }
  }, [dispatch, sessionIdRef]);

  const toggleSessionPlugin = useCallback(
    async (pluginId: string, enable: boolean) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      dispatch({ type: "TOGGLE_SESSION_PLUGIN", pluginId, isActive: enable });
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
        const approved = await requestConfirm({
          title: i18n.t("plugin.approval.title"),
          message: i18n.t("plugin.approval.confirmMessage", {
            pluginId: firstResult.pending.pluginId,
            action: firstResult.pending.action,
          }),
          confirmLabel: i18n.t("plugin.approval.allow"),
          cancelLabel: i18n.t("plugin.approval.deny"),
        });
        if (!approved) {
          dispatch({
            type: "TOGGLE_SESSION_PLUGIN",
            pluginId,
            isActive: false,
          });
          await workspace.run(sid, `plugin-deny:${crypto.randomUUID()}`, () =>
            api.resolveApproval(firstResult.approvalId, "deny", "session", sid),
          );
          return;
        }

        await workspace.run(
          sid,
          `plugin-approve:${crypto.randomUUID()}`,
          async () => {
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
          isActive: !enable,
        });
      }
    },
    [dispatch, workspace, sessionIdRef],
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
      const sid = sessionIdRef.current;
      if (!sid) return;
      const { result, events } = await workspace.run(
        sid,
        `resume:${crypto.randomUUID()}`,
        () => api.resumeSuspension(sid, suspensionId, data),
      );
      applyResumeEvents(events);
      dispatch({
        type: "UPSERT_EXECUTION_STEP",
        step: {
          runtimeId: result.runtimeId,
          pluginId: result.pluginId,
          status: toExecutionStepStatus(result.status),
          turnId: result.turnId,
          ...(typeof result.durationMs === "number"
            ? { durationMs: result.durationMs }
            : {}),
          ...(result.error ? { detail: result.error } : {}),
        },
      });
      dispatch({ type: "REMOVE_SUSPENSION", suspensionId });
    },
    [dispatch, workspace, sessionIdRef, applyResumeEvents],
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
