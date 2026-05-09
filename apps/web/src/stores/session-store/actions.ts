import { useCallback, useMemo } from "react";
import i18n from "i18next";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import {
  resetPluginData,
  setActiveSession as setActivePluginDataSession,
} from "@/stores/plugin-data-store.js";
import { bootSessionStore } from "./boot.js";
import type { SessionContextValue } from "./context.js";
import { toExecutionStepStatus } from "./execution-steps.js";
import { restoreSessionState } from "./restore-session.js";
import {
  ensureServerThenRun,
  finalizeActionExecution,
  runActionStream,
} from "./runtime-rpc.js";
import type { SessionRuntimeRefs } from "./runtime-refs.js";
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

export function useSessionActions({
  state,
  dispatch,
  ds,
  refs,
  handleSseEvent,
}: UseSessionActionsOptions): Omit<SessionContextValue, "state"> {
  const { sessionIdRef } = refs;

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
          requestId: api.uid(),
          type: "start_session",
          sessionId,
          locale: i18n.language,
          payload: loreOverride ? { loreOverride } : {},
        },
        handleSseEvent,
        dispatch,
      ).finally(() => finalizeActionExecution(dispatch));
    };

    void api
      .getWorldOverlay(worldId)
      .then((overlay) => postStart(overlay?.lore))
      .catch(() => postStart());
  }, [state, handleSseEvent, dispatch]);

  const restoreSession = useCallback(
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

  const resumeSession = useCallback(
    async (session: api.SessionRecord) => {
      await restoreSession(session);
    },
    [restoreSession],
  );

  const resumeSessionById = useCallback(
    async (sessionId: string) => {
      const session = await ds.getSession(sessionId);
      if (!session) throw new Error("Session not found: " + sessionId);
      await restoreSession(session);
    },
    [ds, restoreSession],
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
        const userMsgId = api.uid();
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
        }).catch(() => {});
      }

      return new Promise<void>((resolve) => {
        const fireAction = () => {
          const isCommand = content.startsWith("/");
          runActionStream(
            {
              requestId: api.uid(),
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

      runSingleAction(content, { echoUserMessage: true }).finally(() =>
        finalizeActionExecution(dispatch),
      );
    },
    [dispatch, state, runSingleAction],
  );

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
          ds.saveSubmittedBlocks(sid, nextIds, nextValues).catch(() => {});
        })
        .catch(() => {});
    },
    [ds, dispatch, sessionIdRef],
  );

  const submitInteraction = useCallback(
    async (
      blockId: string,
      _turnId: string,
      interactionId: string,
      type: "form" | "choice" | "confirmation",
      values: Record<string, unknown>,
      submitBehavior?: { echoFilledNarrative?: boolean },
    ) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const echo = submitBehavior?.echoFilledNarrative !== false;

      try {
        submitBlock(blockId, values);

        const result = await api.submitInputs(sid, {
          turnId: _turnId,
          submissions: [{ interactionId, type, values }],
        });

        try {
          const snapshot = await api.getSessionSnapshot(sid);
          if (sessionIdRef.current === sid) {
            const enrichedState: Record<string, unknown> = {
              characters: snapshot.characters,
            };
            if (snapshot.characterSchema) {
              enrichedState.characterSchema = snapshot.characterSchema;
            }
            dispatch({ type: "SET_GAME_STATE", state: enrichedState });
          }
        } catch {
          // Non-critical: character panel will update on next refresh.
        }

        const filled = result.results?.[0]?.filledNarrative ?? "";
        dispatch({ type: "SET_EXECUTING", value: true });
        dispatch({ type: "SET_EXECUTION_ERROR", error: null });
        try {
          await runSingleAction(echo ? filled : "", {
            echoUserMessage: echo && Boolean(filled),
          });
        } finally {
          finalizeActionExecution(dispatch);
        }
      } catch (err) {
        console.error("[submitInteraction] Failed:", err);
        sendMessage(Object.values(values).join(", "));
      }
    },
    [dispatch, sessionIdRef, submitBlock, sendMessage, runSingleAction],
  );

  const runKernelAction = useCallback(
    (request: api.ActionRequest): void => {
      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      runActionStream(request, handleSseEvent, dispatch).finally(() =>
        finalizeActionExecution(dispatch),
      );
    },
    [dispatch, handleSseEvent],
  );

  const executeCommand = useCallback(
    (command: string) => {
      if (!canRunSessionAction(state)) return;
      const sessionId = state.session?.id;
      if (!sessionId) return;

      ensureServerThenRun(ds, sessionId, () =>
        runKernelAction({
          requestId: api.uid(),
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
        dispatch({
          type: "REMOVE_MESSAGES_FROM_TURN",
          turnId: lastTurnId,
          keepRuntimeIds: new Set<string>(),
        });
      }

      ensureServerThenRun(ds, sessionId, () =>
        runKernelAction({
          requestId: api.uid(),
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
          await api.enableSessionPlugin(sid, pluginId);
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

  const triggerEvent = useCallback(
    (eventType: string, eventData: Record<string, unknown>) => {
      if (!canRunSessionAction(state)) return;
      const sessionId = state.session?.id;
      if (!sessionId) return;

      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      const fireAction = () => {
        api.triggerEvent(
          sessionId,
          eventType,
          eventData,
          i18n.language,
          handleSseEvent,
          (err) => {
            dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
            finalizeActionExecution(dispatch);
          },
          () => finalizeActionExecution(dispatch),
        );
      };

      ensureServerThenRun(ds, sessionId, fireAction);
    },
    [ds, dispatch, state, handleSseEvent],
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

  const setComposerText = useCallback((_text: string) => {
    // V1 composer state lives in GameView; this callback preserves plugin API compatibility.
  }, []);

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
      // Non-critical: feature flag may be off, or network may blip.
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
      triggerEvent,
      upsertInteractionDraft,
      removeInteractionDraft,
      clearInteractionDrafts,
      setComposerText,
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
      triggerEvent,
      upsertInteractionDraft,
      removeInteractionDraft,
      clearInteractionDrafts,
      setComposerText,
      resumeSuspension,
      cancelSuspension,
      refreshSuspensions,
    ],
  );
}
