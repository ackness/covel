import { createContext, useContext, useReducer, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import i18n from "i18next";
import * as api from "@/services/api";
import { getDataService } from "@/services/data-service";
import { migrateLocalStorageToIdb } from "@/services/app-kv-store";
import { setBlockSchemas } from "@/components/blocks/block-renderer.js";
import type { BlockSchemaDeclaration } from "@covel/shared";

// ── Types ──────────────────────────────────────────────────────────

export interface StreamMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
  turnId?: string;
  /** Source runtime ID for retry tracking. */
  runtimeId?: string;
  /** For UI blocks (choice_set, etc.) */
  block?: Record<string, unknown>;
}

/** A single step in the execution timeline, streamed from the kernel. */
export interface ExecutionStep {
  type: "runtime.started" | "runtime.completed" | "runtime.failed" | "llm.calling" | "tool.calling" | "tool.completed";
  runtimeId: string;
  pluginId: string;
  label?: string;
  detail?: string;
  timestamp: string;
}

interface SessionState {
  // Boot data
  presets: api.PresetSummary[];
  packages: api.PackageSummary[];
  /** Plugins that failed to load (manifest or dependency errors). */
  pluginLoadErrors: api.PluginLoadError[];
  commands: api.CommandSummary[];
  worlds: api.WorldRecord[];
  /** Server-side llm.toml config (null = legacy / unconfigured). */
  llmConfig: api.LlmConfigResponse | null;
  booted: boolean;
  bootError: string | null;

  // Active session
  world: api.WorldRecord | null;
  session: api.SessionRecord | null;
  phase: api.SessionPhase;
  messages: StreamMessage[];

  /** All sessions for the current world (for switching). */
  worldSessions: api.SessionRecord[];

  // Execution
  executing: boolean;
  executionError: string | null;
  /** Real-time execution progress steps from kernel. */
  executionSteps: ExecutionStep[];

  // State patches from kernel
  statePatches: Array<{ id: string; summary: string; packageName: string; data?: unknown }>;

  /** Accumulated game state from state.patch events. */
  gameState: Record<string, unknown>;

  /** Block IDs that have been submitted by the player (permanently locked). */
  submittedBlockIds: ReadonlySet<string>;
}

type Action =
  | { type: "BOOT_SUCCESS"; presets: api.PresetSummary[]; packages: api.PackageSummary[]; pluginLoadErrors: api.PluginLoadError[]; commands: api.CommandSummary[]; worlds: api.WorldRecord[]; llmConfig: api.LlmConfigResponse | null }
  | { type: "BOOT_ERROR"; error: string }
  | { type: "SET_WORLD"; world: api.WorldRecord }
  | { type: "ADD_WORLD"; world: api.WorldRecord }
  | { type: "UPDATE_WORLD"; world: api.WorldRecord }
  | { type: "SET_SESSION"; session: api.SessionRecord }
  | { type: "SET_WORLD_SESSIONS"; sessions: api.SessionRecord[] }
  | { type: "ADD_MESSAGE"; message: StreamMessage }
  | { type: "COMPLETE_MESSAGE"; turnId: string; runtimeId: string; message: StreamMessage }
  | { type: "APPEND_DELTA"; turnId: string; runtimeId: string; pluginId: string; delta: string }
  | { type: "SET_EXECUTING"; value: boolean }
  | { type: "SET_EXECUTION_ERROR"; error: string | null }
  | { type: "ADD_STATE_PATCH"; patch: { id: string; summary: string; packageName: string; data?: unknown } }
  | { type: "LOAD_MESSAGES"; messages: StreamMessage[] }
  | { type: "LOAD_STATE_PATCHES"; patches: Array<{ id: string; summary: string; packageName: string; data?: unknown }> }
  | { type: "SET_PHASE"; phase: api.SessionPhase }
  | { type: "ADD_EXECUTION_STEP"; step: ExecutionStep }
  | { type: "CLEAR_EXECUTION_STEPS" }
  | { type: "RESET_SESSION" }
  | { type: "SUBMIT_BLOCK"; blockId: string }
  | { type: "RESET_TO_WORLD_SELECT" }
  | { type: "REMOVE_MESSAGES_FROM_TURN"; turnId: string; keepRuntimeIds: ReadonlySet<string> }
  | { type: "SET_GAME_STATE"; state: Record<string, unknown> }
  | { type: "REMOVE_SESSION"; sessionId: string };

const initialState: SessionState = {
  presets: [],
  packages: [],
  pluginLoadErrors: [],
  commands: [],
  worlds: [],
  llmConfig: null,
  booted: false,
  bootError: null,
  world: null,
  session: null,
  phase: "init",
  messages: [],
  worldSessions: [],
  executing: false,
  executionError: null,
  executionSteps: [],
  statePatches: [],
  gameState: {},
  submittedBlockIds: new Set<string>(),
};

/** Recursively merge plain objects; non-object values are overwritten. */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const tVal = result[key];
    const sVal = source[key];
    if (
      tVal && sVal &&
      typeof tVal === "object" && !Array.isArray(tVal) &&
      typeof sVal === "object" && !Array.isArray(sVal)
    ) {
      result[key] = deepMerge(
        tVal as Record<string, unknown>,
        sVal as Record<string, unknown>,
      );
    } else {
      result[key] = sVal;
    }
  }
  return result;
}

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "BOOT_SUCCESS":
      return { ...state, booted: true, bootError: null, presets: action.presets, packages: action.packages, pluginLoadErrors: action.pluginLoadErrors, commands: action.commands, worlds: action.worlds, llmConfig: action.llmConfig };
    case "BOOT_ERROR":
      return { ...state, bootError: action.error };
    case "SET_WORLD":
      return { ...state, world: action.world };
    case "ADD_WORLD":
      return { ...state, worlds: [...state.worlds, action.world] };
    case "UPDATE_WORLD":
      return {
        ...state,
        worlds: state.worlds.map((w) => w.id === action.world.id ? action.world : w),
        world: state.world?.id === action.world.id ? action.world : state.world,
      };
    case "SET_SESSION":
      return { ...state, session: action.session, phase: action.session.phase ?? "init" };
    case "SET_WORLD_SESSIONS":
      return { ...state, worldSessions: action.sessions };
    case "REMOVE_SESSION":
      return { ...state, worldSessions: state.worldSessions.filter((s) => s.id !== action.sessionId) };
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "COMPLETE_MESSAGE": {
      // If a streaming message already exists for this turn+runtime, skip the completed message
      // since the streamed version is already displayed.
      const streamId = `stream_${action.turnId}_${action.runtimeId}`;
      const hasStreamed = state.messages.some((m) => m.id === streamId);
      if (hasStreamed) return state;
      return { ...state, messages: [...state.messages, action.message] };
    }
    case "APPEND_DELTA": {
      // Find existing streaming message for this runtime, or create one
      const streamId = `stream_${action.turnId}_${action.runtimeId}`;
      const idx = state.messages.findIndex((m) => m.id === streamId);
      if (idx >= 0) {
        const updated = [...state.messages];
        updated[idx] = { ...updated[idx], content: updated[idx].content + action.delta };
        return { ...state, messages: updated };
      }
      // Create new streaming message
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: streamId,
            role: "assistant",
            content: action.delta,
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }
    case "SET_EXECUTING":
      return { ...state, executing: action.value };
    case "SET_EXECUTION_ERROR":
      return { ...state, executionError: action.error };
    case "ADD_STATE_PATCH": {
      const patchData = action.patch.data as Record<string, unknown> | undefined;
      const newGameState = patchData
        ? deepMerge(state.gameState, patchData)
        : state.gameState;
      return {
        ...state,
        statePatches: [...state.statePatches, action.patch],
        gameState: newGameState,
      };
    }
    case "LOAD_MESSAGES":
      return { ...state, messages: action.messages };
    case "LOAD_STATE_PATCHES": {
      let rebuiltGameState: Record<string, unknown> = {};
      for (const patch of action.patches) {
        if (patch.data && typeof patch.data === "object") {
          rebuiltGameState = deepMerge(rebuiltGameState, patch.data as Record<string, unknown>);
        }
      }
      return { ...state, statePatches: action.patches, gameState: rebuiltGameState };
    }
    case "SET_PHASE":
      return { ...state, phase: action.phase };
    case "SET_GAME_STATE":
      return { ...state, gameState: action.state };
    case "ADD_EXECUTION_STEP":
      return { ...state, executionSteps: [...state.executionSteps, action.step] };
    case "CLEAR_EXECUTION_STEPS":
      return { ...state, executionSteps: [] };
    case "SUBMIT_BLOCK":
      return { ...state, submittedBlockIds: new Set([...state.submittedBlockIds, action.blockId]) };
    case "RESET_SESSION":
      return { ...state, session: null, phase: "init", messages: [], statePatches: [], gameState: {}, executing: false, executionError: null, executionSteps: [], submittedBlockIds: new Set<string>() };
    case "RESET_TO_WORLD_SELECT":
      return { ...state, world: null, session: null, phase: "init", messages: [], worldSessions: [], statePatches: [], gameState: {}, executing: false, executionError: null, executionSteps: [], submittedBlockIds: new Set<string>() };
    case "REMOVE_MESSAGES_FROM_TURN": {
      // Remove messages from a specific turn, except those from cached runtimes
      const filtered = state.messages.filter((m) => {
        if (m.turnId !== action.turnId) return true;
        if (m.runtimeId && action.keepRuntimeIds.has(m.runtimeId)) return true;
        return false;
      });
      return { ...state, messages: filtered };
    }
    default:
      return state;
  }
}

// ── Context ────────────────────────────────────────────────────────

interface SessionContextValue {
  state: SessionState;
  boot: () => Promise<void>;
  selectWorld: (worldId: string) => void;
  startGame: () => Promise<void>;
  /** Resume a previously created session. */
  resumeSession: (session: api.SessionRecord) => Promise<void>;
  /** Resume a session by ID (for URL-based auto-resume on refresh). */
  resumeSessionById: (sessionId: string) => Promise<void>;
  /** Load all sessions for the current world. */
  loadWorldSessions: () => Promise<void>;
  /** Delete a session and all its data. */
  deleteSession: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => void;
  /** Mark a block as submitted (permanently locks it). */
  submitBlock: (blockId: string) => void;
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
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const ds = useMemo(() => getDataService(), []);

  // Ref to track current session ID for use in callbacks (avoids stale closures)
  const sessionIdRef = useRef<string | null>(null);
  // Track runtime kind (story vs plugin) so we can filter non-story text from main chat
  const runtimeKindRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    sessionIdRef.current = state.session?.id ?? null;
  }, [state.session]);

  const boot = useCallback(async () => {
    // Migrate localStorage game data to IndexedDB (one-time, idempotent)
    await migrateLocalStorageToIdb();

    try {
      const [presets, packagesRes, commands, worlds, schemas, llmConfig] = await Promise.all([
        api.listPresets(),
        api.listPackages(),
        api.listCommands(),
        ds.listWorlds(),
        api.fetchBlockSchemas().catch(() => ({})),
        api.fetchLlmConfig().catch(() => null),
      ]);
      setBlockSchemas(schemas as Record<string, BlockSchemaDeclaration>);
      dispatch({
        type: "BOOT_SUCCESS",
        presets,
        packages: packagesRes.packages,
        pluginLoadErrors: packagesRes.loadErrors,
        commands,
        worlds,
        llmConfig,
      });

      // Auto-load server-configured provider keys (from .env.llm).
      // Only fills if user hasn't manually configured keys in browser.
      try {
        const res = await fetch("/api/provider-keys");
        if (res.ok) {
          const { keys } = await res.json();
          if (keys && typeof keys === "object" && !Array.isArray(keys)) {
            const existing = api.getProviderKeys();
            if (Object.keys(existing).length === 0 && Object.keys(keys as Record<string, string>).length > 0) {
              api.setProviderKeys(keys as Record<string, string>);
            }
          }
        }
      } catch {
        // Provider keys endpoint not available, skip
      }
    } catch (err) {
      dispatch({ type: "BOOT_ERROR", error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const handleSseEvent = useCallback((envelope: api.SseEnvelope) => {
    const { type, payload, turnId } = envelope;

    switch (type) {
      case "message.delta": {
        const delta = (payload.delta as string) ?? "";
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const pluginId = (payload.pluginId as string) ?? "";
        // Only show story-kind runtime text in main chat; plugin text goes to debug only
        const deltaKind = runtimeKindRef.current.get(runtimeId);
        if (delta && deltaKind === "story") {
          dispatch({ type: "APPEND_DELTA", turnId: turnId ?? "unknown", runtimeId, pluginId, delta });
        }
        break;
      }
      case "message.completed": {
        // When streaming is active, message.completed duplicates streamed content.
        // Dispatch a deduplicated action — the reducer checks for existing stream messages.
        const content = (payload.content as string) ?? "";
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        // Only show story-kind runtime text in main chat; plugin text goes to debug only
        const completedKind = runtimeKindRef.current.get(runtimeId);
        if (content && completedKind === "story") {
          const msgId = (payload.messageId as string) ?? api.uid();
          const msg: StreamMessage = {
            id: msgId,
            role: "assistant",
            content,
            timestamp: envelope.timestamp,
            turnId,
            runtimeId: runtimeId !== "unknown" ? runtimeId : undefined,
          };
          dispatch({ type: "COMPLETE_MESSAGE", turnId: turnId ?? "unknown", runtimeId, message: msg });
          // Persist to IDB (fire-and-forget). Use the final content for the stream message.
          const sid = sessionIdRef.current;
          if (sid) {
            // For streamed messages, the reducer may skip COMPLETE_MESSAGE if stream exists.
            // We persist the final content regardless — IDB uses msgId as key for dedup.
            ds.addMessage({
              id: msgId,
              sessionId: sid,
              role: "assistant",
              content,
              turnId,
              runtimeId: runtimeId !== "unknown" ? runtimeId : undefined,
              createdAt: envelope.timestamp,
            }).catch(() => {});
          }
        }
        break;
      }
      case "block.emitted": {
        const block = payload.block as Record<string, unknown>;
        if (block) {
          const blockMeta = block.meta as Record<string, unknown> | undefined;
          const blockId = (block.id as string) ?? api.uid();
          const msg: StreamMessage = {
            id: blockId,
            role: "assistant",
            content: "",
            timestamp: envelope.timestamp,
            turnId,
            runtimeId: (blockMeta?.runtimeId as string) || undefined,
            block,
          };
          dispatch({ type: "ADD_MESSAGE", message: msg });
          // Persist block message to IDB
          const sid = sessionIdRef.current;
          if (sid) {
            ds.addMessage({
              id: blockId,
              sessionId: sid,
              role: "assistant",
              content: "",
              turnId,
              runtimeId: (blockMeta?.runtimeId as string) || undefined,
              block,
              createdAt: envelope.timestamp,
            }).catch(() => {});
          }
        }
        break;
      }
      case "state.patch.applied": {
        const patch = payload.patch as { id: string; summary: string; packageName: string; data?: unknown };
        if (patch) {
          dispatch({ type: "ADD_STATE_PATCH", patch });
          // Persist state patch to IDB
          const sid = sessionIdRef.current;
          if (sid) {
            ds.addStatePatch(sid, {
              ...patch,
              sessionId: sid,
              createdAt: new Date().toISOString(),
            }).catch(() => {});
          }
        }
        break;
      }
      case "state.snapshot": {
        const snapshotState = payload.state as Record<string, unknown> | undefined;
        if (snapshotState) {
          dispatch({ type: "SET_GAME_STATE", state: snapshotState });
          // Persist to DataService (T1/T2: IndexedDB, T3: no-op)
          const sid = sessionIdRef.current;
          if (sid) {
            getDataService()
              .persistStateSnapshot(sid, payload as Record<string, unknown>)
              .catch((err: unknown) => console.warn("[session] Failed to persist state snapshot:", err));
          }
        }
        break;
      }
      case "phase_change": {
        const phase = payload.phase as api.SessionPhase;
        if (phase) {
          dispatch({ type: "SET_PHASE", phase });
        }
        break;
      }
      case "runtime.progress": {
        const step: ExecutionStep = {
          type: payload.type as ExecutionStep["type"],
          runtimeId: payload.runtimeId as string,
          pluginId: payload.pluginId as string,
          label: payload.label as string | undefined,
          detail: payload.detail as string | undefined,
          timestamp: payload.timestamp as string,
        };
        // Track runtime kind from runtime.started label (format: "pluginId/kind")
        if (step.type === "runtime.started" && step.label) {
          const slashIdx = step.label.indexOf("/");
          if (slashIdx >= 0) {
            runtimeKindRef.current.set(step.runtimeId, step.label.slice(slashIdx + 1));
          }
        }
        dispatch({ type: "ADD_EXECUTION_STEP", step });
        break;
      }
      case "flow.failed": {
        dispatch({ type: "SET_EXECUTION_ERROR", error: (payload.message as string) ?? "Execution failed" });
        dispatch({ type: "SET_EXECUTING", value: false });
        break;
      }
      case "flow.completed": {
        dispatch({ type: "SET_EXECUTING", value: false });
        break;
      }
    }
  }, []);

  const selectWorld = useCallback((worldId: string) => {
    dispatch({ type: "RESET_SESSION" });
    const world = state.worlds.find((w) => w.id === worldId);
    if (world) {
      dispatch({ type: "SET_WORLD", world });
    }
  }, [state.worlds]);

  const startGame = useCallback(async () => {
    if (!state.world) return;
    try {
      // Use user's slot config (default slot) if configured, else fall back to server default
      const slotConfig = api.getSlotConfig();
      const defaultPresetId = slotConfig.default?.presetId;
      const presetId = defaultPresetId
        ?? state.presets.find((p) => p.isDefault)?.id
        ?? state.presets[0]?.id;
      const session = await ds.createSession(state.world.id, presetId);
      dispatch({ type: "SET_SESSION", session });
      // Sync context to server so stateless server can process the turn
      await ds.syncToServer(session.id);
      api.markServerAck();

      const overlay = await api.getWorldOverlay(state.world.id);
      const loreOverride = overlay?.lore;

      dispatch({ type: "CLEAR_EXECUTION_STEPS" });
      dispatch({ type: "SET_EXECUTING", value: true });
      api.sendAction(
        {
          requestId: api.uid(),
          type: "start_session",
          sessionId: session.id,
          locale: i18n.language,
          payload: { ...(loreOverride ? { loreOverride } : {}) },
        },
        handleSseEvent,
        (err) => {
          dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
          dispatch({ type: "SET_EXECUTING", value: false });
        },
        () => {
          dispatch({ type: "SET_EXECUTING", value: false });
        }
      );
    } catch (err) {
      dispatch({ type: "SET_EXECUTION_ERROR", error: (err as Error).message });
    }
  }, [state.world, state.presets, handleSseEvent]);

  /** Shared logic for fully restoring a session from server data. */
  const restoreSession = useCallback(async (session: api.SessionRecord) => {
    // Clear stale state from previous session before loading the new one
    dispatch({ type: "RESET_SESSION" });

    // Set the world context
    const world = state.worlds.find((w) => w.id === session.worldId);
    if (world) {
      dispatch({ type: "SET_WORLD", world });
    }
    dispatch({ type: "SET_SESSION", session });

    // Load messages, state patches, and state snapshot in parallel
    const [messagesResult, patchesResult, snapshotResult] = await Promise.allSettled([
      ds.listMessages(session.id),
      ds.listStatePatches(session.id),
      ds.loadStateSnapshot(session.id),
    ]);

    // Restore messages (including block data)
    if (messagesResult.status === "fulfilled") {
      const streamMessages: StreamMessage[] = messagesResult.value.map((m) => ({
        id: m.id,
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
        timestamp: m.createdAt,
        turnId: m.turnId,
        runtimeId: m.runtimeId,
        ...(m.block ? { block: m.block } : {}),
      }));
      dispatch({ type: "LOAD_MESSAGES", messages: streamMessages });
    } else {
      // Message loading failed — user won't see historical messages but can still play
      void messagesResult.reason;
    }

    // Restore state patches and rebuild gameState
    if (patchesResult.status === "fulfilled") {
      dispatch({ type: "LOAD_STATE_PATCHES", patches: patchesResult.value });
    }

    // Restore state snapshot (overrides patch-rebuilt state if available)
    if (snapshotResult.status === "fulfilled" && snapshotResult.value) {
      const snapshot = snapshotResult.value;
      const snapshotState = snapshot.state as Record<string, unknown> | undefined;
      if (snapshotState) {
        dispatch({ type: "SET_GAME_STATE", state: snapshotState });
      }
    }

    // Sync session context to server so subsequent turns can be processed
    ds.syncToServer(session.id).then(() => {
      api.markServerAck();
    }).catch((err: unknown) => {
      console.warn("[session] Failed to sync to server on resume:", err);
    });
  }, [state.worlds]);

  const resumeSession = useCallback(async (session: api.SessionRecord) => {
    await restoreSession(session);
  }, [restoreSession]);

  const resumeSessionById = useCallback(async (sessionId: string) => {
    const session = await ds.getSession(sessionId);
    if (!session) throw new Error("Session not found: " + sessionId);
    await restoreSession(session);
  }, [restoreSession]);

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

  const sendMessage = useCallback((content: string) => {
    if (!state.session || state.executing) return;

    const sessionId = state.session.id;

    // Add user message immediately
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

    // Persist user message to IDB
    ds.addMessage({
      id: userMsgId,
      sessionId,
      role: "user",
      content,
      createdAt: userTimestamp,
    }).catch(() => {});

    dispatch({ type: "CLEAR_EXECUTION_STEPS" });
    dispatch({ type: "SET_EXECUTING", value: true });
    dispatch({ type: "SET_EXECUTION_ERROR", error: null });

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
          dispatch({ type: "SET_EXECUTING", value: false });
        },
        () => {
          dispatch({ type: "SET_EXECUTING", value: false });
        },
      );
    };

    // Guard: re-sync if server restarted after idle (e.g. Render free-tier sleep)
    api.ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
      .then(fireAction)
      .catch(fireAction); // proceed anyway — let the action surface the real error
  }, [state.session, state.executing, handleSseEvent]);

  const submitBlock = useCallback((blockId: string) => {
    dispatch({ type: "SUBMIT_BLOCK", blockId });
  }, []);

  const executeCommand = useCallback((command: string) => {
    if (!state.session || state.executing) return;

    const sessionId = state.session.id;

    dispatch({ type: "CLEAR_EXECUTION_STEPS" });
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
        },
        () => {
          dispatch({ type: "SET_EXECUTING", value: false });
        },
      );
    };

    api.ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
      .then(fireAction)
      .catch(fireAction);
  }, [state.session, state.executing, handleSseEvent]);

  const retryRuntime = useCallback((runtimeId?: string) => {
    if (!state.session || state.executing) return;

    // Find the last turn's messages and determine which runtimes' results to keep
    // When retrying from a specific runtime, messages from that runtime and later
    // should be removed. For "retry all", remove all assistant messages from the last turn.
    const lastTurnId = state.messages.length > 0
      ? [...state.messages].reverse().find((m) => m.turnId)?.turnId
      : undefined;

    if (lastTurnId) {
      // For retry from specific runtime: find its priority from execution steps.
      // We keep messages from runtimes that completed before the target.
      // For simplicity, we remove all messages from the last turn and let new ones stream in.
      // The kernel will replay cached results for earlier runtimes (they'll send runtime.progress
      // with [cached] but not message.delta/completed for cached narrative).
      dispatch({ type: "REMOVE_MESSAGES_FROM_TURN", turnId: lastTurnId, keepRuntimeIds: new Set<string>() });
    }

    const sessionId = state.session.id;

    dispatch({ type: "CLEAR_EXECUTION_STEPS" });
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
        },
        () => {
          dispatch({ type: "SET_EXECUTING", value: false });
        },
      );
    };

    api.ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
      .then(fireAction)
      .catch(fireAction);
  }, [state.session, state.executing, state.messages, handleSseEvent]);

  // Boot on mount
  useEffect(() => {
    if (!state.booted && !state.bootError) {
      boot();
    }
  }, [boot, state.booted, state.bootError]);

  const resetSession = useCallback(() => {
    dispatch({ type: "RESET_SESSION" });
  }, []);

  const backToWorldSelect = useCallback(() => {
    dispatch({ type: "RESET_TO_WORLD_SELECT" });
  }, []);

  const updateWorldLocal = useCallback((world: api.WorldRecord) => {
    dispatch({ type: "UPDATE_WORLD", world });
  }, []);

  const addWorldLocal = useCallback((world: api.WorldRecord) => {
    dispatch({ type: "ADD_WORLD", world });
  }, []);

  const value: SessionContextValue = {
    state,
    boot,
    selectWorld,
    startGame,
    resumeSession,
    resumeSessionById,
    loadWorldSessions,
    deleteSession,
    sendMessage,
    submitBlock,
    executeCommand,
    retryRuntime,
    resetSession,
    backToWorldSelect,
    updateWorldLocal,
    addWorldLocal,
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
