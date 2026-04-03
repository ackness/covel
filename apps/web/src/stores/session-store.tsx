import { createContext, useContext, useReducer, useCallback, useEffect, useMemo, type ReactNode } from "react";
import i18n from "i18next";
import * as api from "@/services/api";
import { getDataService } from "@/services/data-service";
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
  | { type: "BOOT_SUCCESS"; presets: api.PresetSummary[]; packages: api.PackageSummary[]; commands: api.CommandSummary[]; worlds: api.WorldRecord[]; llmConfig: api.LlmConfigResponse | null }
  | { type: "BOOT_ERROR"; error: string }
  | { type: "SET_WORLD"; world: api.WorldRecord }
  | { type: "UPDATE_WORLD"; world: api.WorldRecord }
  | { type: "SET_SESSION"; session: api.SessionRecord }
  | { type: "SET_WORLD_SESSIONS"; sessions: api.SessionRecord[] }
  | { type: "ADD_MESSAGE"; message: StreamMessage }
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
  | { type: "REMOVE_MESSAGES_FROM_TURN"; turnId: string; keepRuntimeIds: ReadonlySet<string> };

const initialState: SessionState = {
  presets: [],
  packages: [],
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
      return { ...state, booted: true, bootError: null, presets: action.presets, packages: action.packages, commands: action.commands, worlds: action.worlds, llmConfig: action.llmConfig };
    case "BOOT_ERROR":
      return { ...state, bootError: action.error };
    case "SET_WORLD":
      return { ...state, world: action.world };
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
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
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
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const ds = useMemo(() => getDataService(), []);

  const boot = useCallback(async () => {
    try {
      const [presets, packages, commands, worlds, schemas, llmConfig] = await Promise.all([
        api.listPresets(),
        api.listPackages(),
        api.listCommands(),
        ds.listWorlds(),
        api.fetchBlockSchemas().catch(() => ({})),
        api.fetchLlmConfig().catch(() => null),
      ]);
      setBlockSchemas(schemas as Record<string, BlockSchemaDeclaration>);
      dispatch({ type: "BOOT_SUCCESS", presets, packages, commands, worlds, llmConfig });

      // Auto-load server-configured provider keys (from .env.llm).
      // Only fills if user hasn't manually configured keys in browser.
      try {
        const res = await fetch("/api/provider-keys");
        if (res.ok) {
          const { keys } = await res.json();
          const existing = api.getProviderKeys();
          if (Object.keys(existing).length === 0 && Object.keys(keys).length > 0) {
            api.setProviderKeys(keys);
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
        if (delta) {
          dispatch({ type: "APPEND_DELTA", turnId: turnId ?? "unknown", runtimeId, pluginId, delta });
        }
        break;
      }
      case "message.completed": {
        // When streaming is active, message.completed may duplicate streamed content.
        // Only add if no streaming message exists for this turn.
        const content = (payload.content as string) ?? "";
        if (content) {
          dispatch({
            type: "ADD_MESSAGE",
            message: {
              id: (payload.messageId as string) ?? api.uid(),
              role: "assistant",
              content,
              timestamp: envelope.timestamp,
              turnId,
              runtimeId: (payload.runtimeId as string) || undefined,
            },
          });
        }
        break;
      }
      case "block.emitted": {
        const block = payload.block as Record<string, unknown>;
        if (block) {
          const blockMeta = block.meta as Record<string, unknown> | undefined;
          dispatch({
            type: "ADD_MESSAGE",
            message: {
              id: (block.id as string) ?? api.uid(),
              role: "assistant",
              content: "",
              timestamp: envelope.timestamp,
              turnId,
              runtimeId: (blockMeta?.runtimeId as string) || undefined,
              block,
            },
          });
        }
        break;
      }
      case "state.patch.applied": {
        const patch = payload.patch as { id: string; summary: string; packageName: string; data?: unknown };
        if (patch) {
          dispatch({ type: "ADD_STATE_PATCH", patch });
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

      const overlay = api.getWorldOverlay(state.world.id);
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

    // Load messages and state patches in parallel
    const [messagesResult, patchesResult] = await Promise.allSettled([
      ds.listMessages(session.id),
      ds.listStatePatches(session.id),
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
      console.warn('[session] Failed to load messages:', messagesResult.reason);
    }

    // Restore state patches and rebuild gameState
    if (patchesResult.status === "fulfilled") {
      dispatch({ type: "LOAD_STATE_PATCHES", patches: patchesResult.value });
    }
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

  const sendMessage = useCallback((content: string) => {
    if (!state.session || state.executing) return;

    // Add user message immediately
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        id: api.uid(),
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      },
    });

    dispatch({ type: "CLEAR_EXECUTION_STEPS" });
    dispatch({ type: "SET_EXECUTING", value: true });
    dispatch({ type: "SET_EXECUTION_ERROR", error: null });

    // Check if it's a slash command
    const isCommand = content.startsWith("/");
    api.sendAction(
      {
        requestId: api.uid(),
        type: isCommand ? "execute_command" : "send_message",
        sessionId: state.session.id,
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
      }
    );
  }, [state.session, state.executing, handleSseEvent]);

  const submitBlock = useCallback((blockId: string) => {
    dispatch({ type: "SUBMIT_BLOCK", blockId });
  }, []);

  const executeCommand = useCallback((command: string) => {
    if (!state.session || state.executing) return;

    dispatch({ type: "CLEAR_EXECUTION_STEPS" });
    dispatch({ type: "SET_EXECUTING", value: true });
    dispatch({ type: "SET_EXECUTION_ERROR", error: null });

    api.sendAction(
      {
        requestId: api.uid(),
        type: "execute_command",
        sessionId: state.session.id,
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
      }
    );
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

    dispatch({ type: "CLEAR_EXECUTION_STEPS" });
    dispatch({ type: "SET_EXECUTING", value: true });
    dispatch({ type: "SET_EXECUTION_ERROR", error: null });

    api.sendAction(
      {
        requestId: api.uid(),
        type: "retry_runtime",
        sessionId: state.session.id,
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
      }
    );
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

  const value: SessionContextValue = {
    state,
    boot,
    selectWorld,
    startGame,
    resumeSession,
    resumeSessionById,
    loadWorldSessions,
    sendMessage,
    submitBlock,
    executeCommand,
    retryRuntime,
    resetSession,
    backToWorldSelect,
    updateWorldLocal,
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
