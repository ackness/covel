import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import i18n from "i18next";
import * as api from "@/services/api";
import { getDataService } from "@/services/data-service";
import {
  resetPluginData,
  setActiveSession as setActivePluginDataSession,
} from "@/stores/plugin-data-store.js";
import { emitToast } from "@/lib/toast-channel.js";
import { bootSessionStore } from "./session-store/boot.js";
import { toExecutionStepStatus } from "./session-store/execution-steps.js";
import { initialState, reducer } from "./session-store/reducer.js";
import { restoreSessionState } from "./session-store/restore-session.js";
import {
  applyResumeEvents as applyResumeSseEvents,
  clearNarrativeDeltaBuffer,
  createSseEventHandler,
  type DeltaBufferRef,
  type DeltaRafRef,
} from "./session-store/sse-handler.js";
import { startGameSession } from "./session-store/start-game.js";
import { useSessionSubscription } from "./session-store/subscription.js";
import type {
  PendingInteractionDraft,
  SessionState,
  SuspensionRecord,
} from "./session-store/types.js";

export type {
  AssetProgressEvent,
  ExecutionStep,
  LegacyPhase,
  PendingInteractionDraft,
  StreamMessage,
  SuspensionRecord,
} from "./session-store/types.js";
export { mergeGameStateForReplacement } from "./session-store/game-state.js";

// ── Context ────────────────────────────────────────────────────────

interface SessionContextValue {
  state: SessionState;
  boot: () => Promise<void>;
  selectWorld: (worldId: string) => void;
  startGame: (plugins?: string[]) => Promise<void>;
  /** Send start_session action to kick off the narrative from GameView. */
  beginAdventure: () => void;
  /** Resume a previously created session. */
  resumeSession: (session: api.SessionRecord) => Promise<void>;
  /** Resume a session by ID (for URL-based auto-resume on refresh). */
  resumeSessionById: (sessionId: string) => Promise<void>;
  /** Load all sessions for the current world. */
  loadWorldSessions: () => Promise<void>;
  /** Delete a session and all its data. */
  deleteSession: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => void;
  /**
   * Mark a block as submitted (permanently locks it).
   * Optionally stash the form values so disabled forms can re-display them.
   */
  submitBlock: (blockId: string, values?: Record<string, unknown>) => void;
  /**
   * Submit an interactive block through the submit-inputs API (form/choice/confirmation).
   *
   * `submitBehavior` is a plugin-declared UX hint on the originating block's
   * `data.submitBehavior`. Currently honoured:
   *   - `echoFilledNarrative`: when `false`, do not surface the filled
   *     narrative as a user-visible message; send empty content instead.
   */
  submitInteraction: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: "form" | "choice" | "confirmation",
    values: Record<string, unknown>,
    submitBehavior?: { echoFilledNarrative?: boolean },
  ) => Promise<void>;
  executeCommand: (command: string) => void;
  /**
   * Retry the last turn from a specific runtime.
   * Pass undefined to retry the entire turn.
   * Removes affected messages and re-executes.
   */
  retryRuntime: (runtimeId?: string) => void;
  /** Reset session but keep world (back to prep screen). */
  resetSession: () => void;
  /** Reset everything including world (back to world selection). */
  backToWorldSelect: () => void;
  /** Update a world record in the local worlds list (after server-side edit). */
  updateWorldLocal: (world: api.WorldRecord) => void;
  /** Add a newly created world to the local worlds list. */
  addWorldLocal: (world: api.WorldRecord) => void;
  /** Remove a deleted world from the local worlds list. */
  removeWorldLocal: (worldId: string) => void;
  /** Load the session-scoped plugin list from the server. */
  loadSessionPlugins: () => Promise<void>;
  /** Enable or disable a plugin for the current session (optimistic update). */
  toggleSessionPlugin: (pluginId: string, enable: boolean) => Promise<void>;
  /** Trigger a custom kernel event (e.g. image generation from a message button). */
  triggerEvent: (eventType: string, eventData: Record<string, unknown>) => void;
  /** Upsert a pending interaction draft (choice / suggestion selection feedback). */
  upsertInteractionDraft: (draft: PendingInteractionDraft) => void;
  /** Remove a pending interaction draft by id. */
  removeInteractionDraft: (id: string) => void;
  /** Clear all pending interaction drafts. */
  clearInteractionDrafts: () => void;
  /** Update the composer text (single-line input field state). */
  setComposerText: (text: string) => void;
  /** F4 — resume a suspended runtime with caller-supplied data. */
  resumeSuspension: (suspensionId: string, data: unknown) => Promise<void>;
  /** F4 — cancel (abandon) a suspended runtime without resuming. */
  cancelSuspension: (suspensionId: string) => Promise<void>;
  /** F4 — refetch suspensions from the server (useful after reconnects). */
  refreshSuspensions: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const ds = useMemo(() => getDataService(), []);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Ref to track current session ID for use in callbacks (avoids stale closures)
  const sessionIdRef = useRef<string | null>(null);
  // Track runtime kind (story vs plugin) so we can filter non-story text from main chat
  const runtimeKindRef = useRef<Map<string, string>>(new Map());
  // Batch streaming deltas: accumulate per-runtime and flush once per animation frame.
  // `flushSessionId` is captured at push time so a session switch mid-stream causes
  // the RAF to drop stale entries instead of bleeding them into the new session.
  const deltaBufferRef = useRef<DeltaBufferRef["current"]>(new Map());
  const deltaRafRef = useRef<DeltaRafRef["current"]>(null);
  useEffect(() => {
    const nextId = state.session?.id ?? null;
    if (sessionIdRef.current === nextId) return;
    sessionIdRef.current = nextId;

    // Bind plugin-data-store to the new active session slot so hooks like
    // usePluginNamespace auto-isolate across session switches. Without this
    // a stale resume path would leak session-1 plugin-data into session 2.
    setActivePluginDataSession(nextId);

    // Cancel any pending delta flush and clear the buffer so tokens from the
    // outgoing session never land in the new session's messages array.
    clearNarrativeDeltaBuffer(deltaBufferRef, deltaRafRef);
  }, [state.session]);

  const boot = useCallback(async () => {
    await bootSessionStore({ dispatch, ds });
  }, [ds]);

  const lastBackfilledTurnIdRef = useRef<string | null>(null);

  // ── Primary SSE Event Handler (/actions SSE) ──────────────────
  const handleSseEvent = useMemo(
    () =>
      createSseEventHandler({
        dispatch,
        ds,
        sessionIdRef,
        stateRef,
        runtimeKindRef,
        deltaBufferRef,
        deltaRafRef,
        lastBackfilledTurnIdRef,
      }),
    [ds],
  );

  const applyResumeEvents = useCallback(
    (events: api.ResumeSuspensionResponse["events"]) => {
      applyResumeSseEvents(events, handleSseEvent);
    },
    [handleSseEvent],
  );

  const selectWorld = useCallback(
    (worldId: string) => {
      dispatch({ type: "RESET_SESSION" });
      const world = state.worlds.find((w) => w.id === worldId);
      if (world) {
        dispatch({ type: "SET_WORLD", world });
      }
    },
    [state.worlds],
  );

  /**
   * Create a new session and enter GameView — does NOT start the narrative.
   * The player presses "开始冒险" inside GameView to actually kick off the LLM flow.
   */
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
    [ds, state.world, state.presets, state.llmConfig],
  );

  /** Send the start_session action to kick off the narrative. Called from GameView. */
  const beginAdventure = useCallback(() => {
    if (!state.session || state.executing) return;
    const sessionId = state.session.id;
    const worldId = state.world?.id ?? "";

    const postStart = (loreOverride?: unknown) => {
      dispatch({ type: "SET_EXECUTING", value: true });
      const payload: Record<string, unknown> = loreOverride
        ? { loreOverride }
        : {};
      api.sendAction(
        {
          requestId: api.uid(),
          type: "start_session",
          sessionId,
          locale: i18n.language,
          payload,
        },
        handleSseEvent,
        (err) => {
          // Session stays valid; user can press 开始冒险 again to retry, so
          // we only surface the error rather than tear anything down.
          dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
          dispatch({ type: "SET_EXECUTING", value: false });
          dispatch({
            type: "FINALIZE_HANGING_RUNTIMES",
            reason: "__i18n:session.reasonConnectionClosed__",
          });
        },
        () => {
          dispatch({ type: "SET_EXECUTING", value: false });
          dispatch({
            type: "FINALIZE_HANGING_RUNTIMES",
            reason: "__i18n:session.reasonConnectionClosed__",
          });
        },
      );
    };

    // Overlay is optional metadata (world lore override). Fetch failures
    // should never block the adventure from starting.
    void api
      .getWorldOverlay(worldId)
      .then((overlay) => postStart(overlay?.lore))
      .catch(() => postStart());
  }, [state.session, state.world, state.executing, handleSseEvent]);

  /** Shared logic for fully restoring a session from server data. */
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
    [ds, state.worlds],
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
    [restoreSession],
  );

  const loadWorldSessions = useCallback(async () => {
    if (!state.world) return;
    try {
      const sessions = await ds.listSessions(state.world.id);
      dispatch({ type: "SET_WORLD_SESSIONS", sessions });
    } catch {
      // silently fail — non-critical
    }
  }, [state.world]);

  const deleteSession = useCallback(async (sessionId: string) => {
    await ds.deleteSession(sessionId);
    dispatch({ type: "REMOVE_SESSION", sessionId });
  }, []);

  /**
   * Fire a single `/api/actions` request and return a Promise that resolves
   * when the SSE stream either finishes (`onDone`) or errors. The caller is
   * expected to own the `executing` flag.
   *
   * Rationale: `sendMessage` below is the public fire-and-forget entry point,
   * but `submitInteraction` needs to await turn completion before returning
   * (so the caller can release its `executing` flag). Promisifying the action
   * call makes that sequencing explicit.
   */
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
          api.sendAction(
            {
              requestId: api.uid(),
              type: isCommand ? "execute_command" : "send_message",
              sessionId,
              locale: i18n.language,
              payload: isCommand ? { command: content } : { content },
            },
            handleSseEvent,
            (err) => {
              dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
              // Transport failure during SSE (dropped connection, server
              // crashed mid-turn). Banner shows up in the inline error row,
              // but a toast is the only thing visible above the fold.
              emitToast(
                "error",
                i18n.t("toast.sendMessageFailed", {
                  defaultValue: "Failed to send message",
                }) as string,
                err.message,
              );
              resolve();
            },
            () => {
              resolve();
            },
          );
        };

        api
          .ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
          .then(fireAction)
          .catch(fireAction);
      });
    },
    [state.session, handleSseEvent],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!state.session || state.executing) return;

      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      runSingleAction(content, { echoUserMessage: true }).finally(() => {
        dispatch({ type: "SET_EXECUTING", value: false });
        dispatch({
          type: "FINALIZE_HANGING_RUNTIMES",
          reason: "__i18n:session.reasonConnectionClosed__",
        });
      });
    },
    [state.session, state.executing, runSingleAction],
  );

  const submitBlock = useCallback(
    (blockId: string, values?: Record<string, unknown>) => {
      dispatch({ type: "SUBMIT_BLOCK", blockId, values });
      // Persist via DataService so submitted state (and form values) survives refresh
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
    [],
  );

  /**
   * Submit an interactive block through the submit-inputs API.
   * This handles: template filling, CharacterRecord creation, phase transition.
   * After submission, triggers the next turn with the filled narrative.
   */
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

      const echo = submitBehavior?.echoFilledNarrative !== false; // default true

      try {
        // 1. Mark block as submitted (UI lock) and stash the values so the
        //    disabled form can repopulate them after refresh.
        submitBlock(blockId, values);

        // 2. Call submit-inputs API — handles template fill, character creation, phase transition
        const result = await api.submitInputs(sid, {
          turnId,
          submissions: [{ interactionId, type, values }],
        });

        // 3. Refresh characters + schema from snapshot API (character may have been created)
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
          // Non-critical: character panel will update on next refresh
        }

        // 4. Trigger the next turn with the filled narrative. This advances
        //    narrator / guide / etc. once with real player context; the player
        //    then decides the following turn. We intentionally never chain an
        //    additional empty-message turn — doing so would re-trigger narrator
        //    without guidance and auto-advance past pending guide suggestions.
        const filled = result.results?.[0]?.filledNarrative ?? "";
        const firstContent = echo ? filled : "";

        dispatch({ type: "SET_EXECUTING", value: true });
        dispatch({ type: "SET_EXECUTION_ERROR", error: null });

        try {
          await runSingleAction(firstContent, {
            echoUserMessage: echo && Boolean(filled),
          });
        } finally {
          dispatch({ type: "SET_EXECUTING", value: false });
          dispatch({
            type: "FINALIZE_HANGING_RUNTIMES",
            reason: "__i18n:session.reasonConnectionClosed__",
          });
        }
      } catch (err) {
        console.error("[submitInteraction] Failed:", err);
        // Still send raw values as fallback
        const rawContent = Object.values(values).join(", ");
        sendMessage(rawContent);
      }
    },
    [submitBlock, sendMessage, runSingleAction],
  );

  const executeCommand = useCallback(
    (command: string) => {
      if (!state.session || state.executing) return;

      const sessionId = state.session.id;

      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      const fireAction = () => {
        api.sendAction(
          {
            requestId: api.uid(),
            type: "execute_command",
            sessionId,
            locale: i18n.language,
            payload: { command },
          },
          handleSseEvent,
          (err) => {
            dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
            dispatch({ type: "SET_EXECUTING", value: false });
            dispatch({
              type: "FINALIZE_HANGING_RUNTIMES",
              reason: "__i18n:session.reasonConnectionClosed__",
            });
          },
          () => {
            dispatch({ type: "SET_EXECUTING", value: false });
            dispatch({
              type: "FINALIZE_HANGING_RUNTIMES",
              reason: "__i18n:session.reasonConnectionClosed__",
            });
          },
        );
      };

      api
        .ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
        .then(fireAction)
        .catch(fireAction);
    },
    [state.session, state.executing, handleSseEvent],
  );

  const retryRuntime = useCallback(
    (runtimeId?: string) => {
      if (!state.session || state.executing) return;

      // Find the last turn's messages and determine which runtimes' results to keep
      // When retrying from a specific runtime, messages from that runtime and later
      // should be removed. For "retry all", remove all assistant messages from the last turn.
      const lastTurnId =
        state.messages.length > 0
          ? [...state.messages].reverse().find((m) => m.turnId)?.turnId
          : undefined;

      if (lastTurnId) {
        // For retry from specific runtime: find its priority from execution steps.
        // We keep messages from runtimes that completed before the target.
        // For simplicity, we remove all messages from the last turn and let new ones stream in.
        // The kernel will replay cached results for earlier runtimes (they'll send runtime.progress
        // with [cached] but not message.delta/completed for cached narrative).
        dispatch({
          type: "REMOVE_MESSAGES_FROM_TURN",
          turnId: lastTurnId,
          keepRuntimeIds: new Set<string>(),
        });
      }

      const sessionId = state.session.id;

      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      const fireAction = () => {
        api.sendAction(
          {
            requestId: api.uid(),
            type: "retry_runtime",
            sessionId,
            locale: i18n.language,
            payload: runtimeId ? { runtimeId } : {},
          },
          handleSseEvent,
          (err) => {
            dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
            dispatch({ type: "SET_EXECUTING", value: false });
            dispatch({
              type: "FINALIZE_HANGING_RUNTIMES",
              reason: "__i18n:session.reasonConnectionClosed__",
            });
          },
          () => {
            dispatch({ type: "SET_EXECUTING", value: false });
            dispatch({
              type: "FINALIZE_HANGING_RUNTIMES",
              reason: "__i18n:session.reasonConnectionClosed__",
            });
          },
        );
      };

      api
        .ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
        .then(fireAction)
        .catch(fireAction);
    },
    [state.session, state.executing, state.messages, handleSseEvent],
  );

  // Boot on mount
  useEffect(() => {
    if (!state.booted && !state.bootError) {
      boot();
    }
  }, [boot, state.booted, state.bootError]);

  // Persist execution steps to DataService whenever they change
  useEffect(() => {
    const sid = state.session?.id;
    if (!sid || state.executionSteps.length === 0) return;
    ds.saveExecutionSteps(sid, state.executionSteps).catch(() => {});
  }, [state.executionSteps, state.session?.id, ds]);

  // Load plugin-declared message-slot UI specs from /api/ui-specs. Each
  // plugin that exposes an `ui.message[]` spec contributes one entry; the
  // frontend synthesises a `plugin_message` block whenever the plugin writes
  // to its `namespace: "message"` plugin-data.
  //
  // After fetching specs, also hydrate each contributing plugin's
  // `message` namespace into the session store. Without this, a page
  // reload would leave `state.pluginData` empty — the message surface
  // only materialises on new SSE events, so previously-written guide /
  // codex blocks would be invisible until the next tool write happens.
  useEffect(() => {
    const sid = state.session?.id;
    if (!sid) {
      dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs: [] });
      return;
    }
    let cancelled = false;
    api
      .fetchUiSpecs(sid)
      .then((res) => {
        if (cancelled) return;
        const specs = res.message ?? [];
        dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs });

        // Seed session-store pluginData[pid].message with server state
        // so applyPluginMessageSurface has a non-empty __turnId on first
        // render after reload. plugin-data-store (used by right-panel)
        // is a separate cache — we intentionally hydrate both paths.
        const pluginIds = new Set(specs.map((e) => e.pluginId));
        for (const pid of pluginIds) {
          api
            .listPluginData(sid, pid, "message")
            .then((items) => {
              if (cancelled || items.length === 0) return;
              dispatch({
                type: "PLUGIN_DATA_CHANGED",
                pluginId: pid,
                changes: items.map((i) => ({
                  namespace: i.namespace,
                  key: i.key,
                  value: i.value,
                  operation: "set",
                })),
              });
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (cancelled) return;
        dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [state.session?.id]);

  useSessionSubscription({
    sessionId: state.session?.id,
    dispatch,
    sessionIdRef,
  });

  const resetSession = useCallback(() => {
    dispatch({ type: "RESET_SESSION" });
    // Wipes the active session's plugin-data slot. The slot binding is
    // updated on the next SET_SESSION via the sessionIdRef effect.
    resetPluginData();
  }, []);

  const backToWorldSelect = useCallback(() => {
    dispatch({ type: "RESET_TO_WORLD_SELECT" });
    // Detach plugin-data-store from any session so hooks return an empty
    // snapshot while the user is back on the world-select screen.
    setActivePluginDataSession(null);
  }, []);

  const updateWorldLocal = useCallback((world: api.WorldRecord) => {
    dispatch({ type: "UPDATE_WORLD", world });
  }, []);

  const addWorldLocal = useCallback((world: api.WorldRecord) => {
    dispatch({ type: "ADD_WORLD", world });
  }, []);

  const removeWorldLocal = useCallback((worldId: string) => {
    dispatch({ type: "REMOVE_WORLD", worldId });
  }, []);

  const loadSessionPlugins = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const res = await api.listSessionPlugins(sid);
      // Discard if session changed during async call
      if (sessionIdRef.current !== sid) return;
      dispatch({ type: "LOAD_SESSION_PLUGINS", plugins: res.available });
    } catch {
      // Non-critical: silently fail — plugins panel is optional
    }
  }, []);

  const toggleSessionPlugin = useCallback(
    async (pluginId: string, enable: boolean) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      // Optimistic update first
      dispatch({ type: "TOGGLE_SESSION_PLUGIN", pluginId, isActive: enable });
      try {
        if (enable) {
          await api.enableSessionPlugin(sid, pluginId);
        } else {
          await api.disableSessionPlugin(sid, pluginId);
        }
      } catch {
        // Revert optimistic update on failure
        dispatch({
          type: "TOGGLE_SESSION_PLUGIN",
          pluginId,
          isActive: !enable,
        });
      }
    },
    [],
  );

  const triggerEvent = useCallback(
    (eventType: string, eventData: Record<string, unknown>) => {
      if (!state.session || state.executing) return;

      const sessionId = state.session.id;
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
            dispatch({ type: "SET_EXECUTING", value: false });
            dispatch({
              type: "FINALIZE_HANGING_RUNTIMES",
              reason: "__i18n:session.reasonConnectionClosed__",
            });
          },
          () => {
            dispatch({ type: "SET_EXECUTING", value: false });
            dispatch({
              type: "FINALIZE_HANGING_RUNTIMES",
              reason: "__i18n:session.reasonConnectionClosed__",
            });
          },
        );
      };

      api
        .ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
        .then(fireAction)
        .catch(fireAction);
    },
    [state.session, state.executing, handleSseEvent],
  );

  const upsertInteractionDraft = useCallback(
    (draft: PendingInteractionDraft) => {
      dispatch({ type: "UPSERT_DRAFT", draft });
    },
    [],
  );

  const removeInteractionDraft = useCallback((id: string) => {
    dispatch({ type: "REMOVE_DRAFT", draftId: id });
  }, []);

  const clearInteractionDrafts = useCallback(() => {
    dispatch({ type: "CLEAR_DRAFTS" });
  }, []);

  // V1 keeps composer text in the GameView local state; exposing a no-op here
  // lets plugin json-render handlers that target `setComposerText` stay
  // compatible without surfacing plugin IDs into the store.
  const setComposerText = useCallback((_text: string) => {
    // no-op on V1 — composer is local to GameView
  }, []);

  // ── F4 suspend/resume ────────────────────────────────────────
  //
  // Resume waits for the server to finish re-entering the tool loop; the
  // backend emits `turn.resumed` which the SSE handler translates into
  // REMOVE_SUSPENSION, so we only dispatch a local removal as a fallback
  // on success. Validation / network errors bubble up so callers can
  // surface them to the user while the suspension remains in the list.
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
      // Belt-and-braces removal in case the SSE event was lost. The reducer
      // is a no-op if the row was already removed by `turn.resumed`.
      dispatch({ type: "REMOVE_SUSPENSION", suspensionId });
    },
    [applyResumeEvents],
  );

  const cancelSuspension = useCallback(async (suspensionId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await api.cancelSuspension(sid, suspensionId);
    dispatch({ type: "REMOVE_SUSPENSION", suspensionId });
  }, []);

  const refreshSuspensions = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const suspensions = await api.listSuspensions(sid);
      if (sessionIdRef.current !== sid) return;
      dispatch({ type: "SET_SUSPENSIONS", suspensions });
    } catch {
      // Non-critical: feature flag may be off, or network blip
    }
  }, []);

  const value: SessionContextValue = {
    state,
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
  };

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
