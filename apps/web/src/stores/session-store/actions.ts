import { useCallback, useMemo } from "react";
import i18n from "i18next";
import * as api from "@/services/api";
import { ignoreError } from "@/lib/ignore-error.js";
import type { DataService } from "@/services/data-service.js";
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
  ensureServerThenRun,
  finalizeActionExecution,
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
  refs: SessionRuntimeRefs;
  handleSseEvent: SseEventHandler;
}

/** Page size for the scroll-up "load older messages" fetch. */
const OLDER_MESSAGES_PAGE_SIZE = 40;

/**
 * The server evolves SessionRecord during a turn (turnCount advances,
 * pre-game completion, status) but the SSE stream carries none of it —
 * without a resync the stage view's turnCount gate stays stale until a
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
        dispatch,
        sessionIdRef,
        world: state.world,
        presets: state.presets,
        llmConfig: state.llmConfig,
        plugins,
      });
    },
    [ds, dispatch, sessionIdRef, state.world, state.presets, state.llmConfig],
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
      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });
      runActionStream(
        {
          requestId: crypto.randomUUID(),
          type: "start_session",
          sessionId,
          locale: i18n.language,
          payload: loreOverride ? { loreOverride } : {},
        },
        handleSseEvent,
        dispatch,
      ).finally(() => {
        finalizeActionExecution(dispatch);
        resyncSession(sessionId);
      });
    };

    void api
      .getWorldOverlay(worldId)
      .then((overlay) => postStart(overlay?.lore))
      .catch(() => postStart());
  }, [state, handleSseEvent, dispatch, resyncSession]);

  const resumeSession = useCallback(
    async (session: api.SessionRecord) => {
      await restoreSessionState({
        ds,
        dispatch,
        sessionIdRef,
        worlds: state.worlds,
        session,
      });
    },
    [ds, dispatch, sessionIdRef, state.worlds],
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
        ds.addMessage({
          id: userMsgId,
          sessionId,
          role: "user",
          content,
          createdAt: userTimestamp,
        }).catch(ignoreError("persist user message"));
      }

      return new Promise<void>((resolve) => {
        const fireAction = () => {
          const isCommand = content.startsWith("/");
          runActionStream(
            {
              requestId: crypto.randomUUID(),
              type: isCommand ? "execute_command" : "send_message",
              sessionId,
              locale: i18n.language,
              payload: isCommand ? { command: content } : { content },
            },
            handleSseEvent,
            dispatch,
            { toastOnError: true },
          ).then(resolve);
        };

        ensureServerThenRun(ds, sessionId, fireAction);
      });
    },
    [ds, dispatch, state.session, handleSseEvent],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!canRunSessionAction(state)) return;

      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      runSingleAction(content, { echoUserMessage: true }).finally(() => {
        finalizeActionExecution(dispatch);
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
      // Echo locally; the server already persisted its copy (remote mode's
      // ds.addMessage is a no-op — this write covers the local-IDB mirror).
      const id = crypto.randomUUID();
      const ts = new Date().toISOString();
      dispatch({
        type: "ADD_MESSAGE",
        message: { id, role: "user", content, timestamp: ts },
      });
      ds.addMessage({
        id,
        sessionId: session.id,
        role: "user",
        content,
        createdAt: ts,
      }).catch(ignoreError("persist steer message"));
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
        const result = await api.submitInputs(sid, {
          turnId,
          submissions: [{ interactionId, type, values }],
        });
        filled = result.results?.[0]?.filledNarrative ?? "";
      } catch (err) {
        console.error("[submitInteraction] submit-form failed:", err);
        sendMessage(Object.values(values).join(", "));
        return;
      }

      // Run the resulting narrative turn, then re-sync the character snapshot.
      //
      // The character panel reads `gameState.characters` (dataSource
      // `session.characters`), and that slice is only filled incrementally by
      // the `character.upserted` SSE event — which fires *solely* from the
      // `character.upsert` proposal path. The primary character-creation paths
      // (char-creator's create/update-character tools and player-init's
      // deterministic guard) write straight to the store and mirror to
      // plugin_data, emitting only `plugin-data.changed`. They never emit
      // `character.upserted`. `characterSchema` has no SSE carrier at all.
      //
      // So after the turn that may have created/updated the player, we pull a
      // snapshot to refresh both `characters` and `characterSchema`. Done after
      // the turn (not before) so a just-created character is included.
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
        finalizeActionExecution(dispatch);
        const sid = sessionIdRef.current;
        if (sid) resyncSession(sid);
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
      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      runActionStream(request, handleSseEvent, dispatch).finally(() => {
        finalizeActionExecution(dispatch);
        if (request.sessionId) resyncSession(request.sessionId);
      });
    },
    [dispatch, handleSseEvent, resyncSession],
  );

  const executeCommand = useCallback(
    (command: string) => {
      if (!canRunSessionAction(state)) return;
      const sessionId = state.session?.id;
      if (!sessionId) return;

      ensureServerThenRun(ds, sessionId, () =>
        runKernelAction({
          requestId: crypto.randomUUID(),
          type: "execute_command",
          sessionId,
          locale: i18n.language,
          payload: { command },
        }),
      );
    },
    [ds, state, runKernelAction],
  );

  const retryRuntime = useCallback(
    (runtimeId?: string) => {
      if (!canRunSessionAction(state)) return;
      const sessionId = state.session?.id;
      if (!sessionId) return;

      const lastTurnId =
        state.messages.length > 0
          ? [...state.messages].reverse().find((message) => message.turnId)
              ?.turnId
          : undefined;
      if (lastTurnId) {
        clearStreamingTextsForTurn(lastTurnId);
        dispatch({
          type: "REMOVE_MESSAGES_FROM_TURN",
          turnId: lastTurnId,
          keepRuntimeIds: new Set<string>(),
        });
      }

      ensureServerThenRun(ds, sessionId, () =>
        runKernelAction({
          requestId: crypto.randomUUID(),
          type: "retry_runtime",
          sessionId,
          locale: i18n.language,
          payload: runtimeId ? { runtimeId } : {},
        }),
      );
    },
    [ds, dispatch, state, runKernelAction],
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
      dispatch({ type: "LOAD_SESSION_PLUGINS", plugins: res.available });
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
        if (enable) {
          let result = await api.enableSessionPlugin(sid, pluginId);
          if ("status" in result && result.status === "approval-required") {
            const approved = window.confirm(
              i18n.t("plugin.approval.confirmMessage", {
                pluginId: result.pending.pluginId,
                action: result.pending.action,
              }),
            );
            await api.resolveApproval(
              result.approvalId,
              approved ? "allow" : "deny",
              "session",
              sid,
            );
            if (!approved) {
              dispatch({
                type: "TOGGLE_SESSION_PLUGIN",
                pluginId,
                isActive: false,
              });
              return;
            }
            result = await api.enableSessionPlugin(sid, pluginId);
            if ("status" in result) {
              throw new Error(i18n.t("plugin.approval.unexpectedRequired"));
            }
          }
        } else {
          await api.disableSessionPlugin(sid, pluginId);
        }
      } catch {
        dispatch({
          type: "TOGGLE_SESSION_PLUGIN",
          pluginId,
          isActive: !enable,
        });
      }
    },
    [dispatch, sessionIdRef],
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
      const { result, events } = await api.resumeSuspension(
        sid,
        suspensionId,
        data,
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
    [dispatch, sessionIdRef, applyResumeEvents],
  );

  const cancelSuspension = useCallback(
    async (suspensionId: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      await api.cancelSuspension(sid, suspensionId);
      dispatch({ type: "REMOVE_SUSPENSION", suspensionId });
    },
    [dispatch, sessionIdRef],
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
