import { createContext, useContext, useReducer, useCallback, useEffect, type ReactNode } from "react";
import * as api from "@/services/api";
import { setBlockSchemas } from "@/components/blocks/block-renderer.js";

// ── Types ──────────────────────────────────────────────────────────

export interface StreamMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
  turnId?: string;
  /** For UI blocks (choice_set, etc.) */
  block?: Record<string, unknown>;
}

interface SessionState {
  // Boot data
  presets: api.PresetSummary[];
  packages: api.PackageSummary[];
  commands: api.CommandSummary[];
  worlds: api.WorldRecord[];
  booted: boolean;
  bootError: string | null;

  // Active session
  world: api.WorldRecord | null;
  session: api.SessionRecord | null;
  phase: api.SessionPhase;
  messages: StreamMessage[];

  // Execution
  executing: boolean;
  executionError: string | null;

  // State patches from kernel
  statePatches: Array<{ id: string; summary: string; packageName: string }>;
}

type Action =
  | { type: "BOOT_SUCCESS"; presets: api.PresetSummary[]; packages: api.PackageSummary[]; commands: api.CommandSummary[]; worlds: api.WorldRecord[] }
  | { type: "BOOT_ERROR"; error: string }
  | { type: "SET_WORLD"; world: api.WorldRecord }
  | { type: "SET_SESSION"; session: api.SessionRecord }
  | { type: "ADD_MESSAGE"; message: StreamMessage }
  | { type: "SET_EXECUTING"; value: boolean }
  | { type: "SET_EXECUTION_ERROR"; error: string | null }
  | { type: "ADD_STATE_PATCH"; patch: { id: string; summary: string; packageName: string } }
  | { type: "LOAD_MESSAGES"; messages: StreamMessage[] }
  | { type: "SET_PHASE"; phase: api.SessionPhase }
  | { type: "RESET_SESSION" };

const initialState: SessionState = {
  presets: [],
  packages: [],
  commands: [],
  worlds: [],
  booted: false,
  bootError: null,
  world: null,
  session: null,
  phase: "init",
  messages: [],
  executing: false,
  executionError: null,
  statePatches: [],
};

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "BOOT_SUCCESS":
      return { ...state, booted: true, bootError: null, presets: action.presets, packages: action.packages, commands: action.commands, worlds: action.worlds };
    case "BOOT_ERROR":
      return { ...state, bootError: action.error };
    case "SET_WORLD":
      return { ...state, world: action.world };
    case "SET_SESSION":
      return { ...state, session: action.session, phase: action.session.phase ?? "init" };
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "SET_EXECUTING":
      return { ...state, executing: action.value };
    case "SET_EXECUTION_ERROR":
      return { ...state, executionError: action.error };
    case "ADD_STATE_PATCH":
      return { ...state, statePatches: [...state.statePatches, action.patch] };
    case "LOAD_MESSAGES":
      return { ...state, messages: action.messages };
    case "SET_PHASE":
      return { ...state, phase: action.phase };
    case "RESET_SESSION":
      return { ...state, session: null, phase: "init", messages: [], statePatches: [], executing: false, executionError: null };
    default:
      return state;
  }
}

// ── Context ────────────────────────────────────────────────────────

interface SessionContextValue {
  state: SessionState;
  boot: () => Promise<void>;
  initSession: (worldId?: string) => Promise<void>;
  sendMessage: (content: string) => void;
  executeCommand: (command: string) => void;
  resetSession: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const boot = useCallback(async () => {
    try {
      const [presets, packages, commands, worlds, schemas] = await Promise.all([
        api.listPresets(),
        api.listPackages(),
        api.listCommands(),
        api.listWorlds(),
        api.fetchBlockSchemas().catch(() => ({})),
      ]);
      setBlockSchemas(schemas as Record<string, any>);
      dispatch({ type: "BOOT_SUCCESS", presets, packages, commands, worlds });
    } catch (err) {
      dispatch({ type: "BOOT_ERROR", error: (err as Error).message });
    }
  }, []);

  const handleSseEvent = useCallback((envelope: api.SseEnvelope) => {
    const { type, payload, turnId } = envelope;

    switch (type) {
      case "message.completed": {
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
            },
          });
        }
        break;
      }
      case "block.emitted": {
        const block = payload.block as Record<string, unknown>;
        if (block) {
          dispatch({
            type: "ADD_MESSAGE",
            message: {
              id: (block.id as string) ?? api.uid(),
              role: "assistant",
              content: "",
              timestamp: envelope.timestamp,
              turnId,
              block,
            },
          });
        }
        break;
      }
      case "state.patch.applied": {
        const patch = payload.patch as { id: string; summary: string; packageName: string };
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

  const initSession = useCallback(async (worldId?: string) => {
    try {
      // Reset current session
      dispatch({ type: "RESET_SESSION" });

      // Find the world
      const worlds = await api.listWorlds();
      let world = worldId
        ? worlds.find((w) => w.id === worldId)
        : worlds[0];
      if (!world) {
        world = await api.createWorld("Custom World", "A new adventure begins.");
      }
      dispatch({ type: "SET_WORLD", world });

      // Create a new session
      const defaultPreset = state.presets.find((p) => p.isDefault) ?? state.presets[0];
      const session = await api.createSession(world.id, defaultPreset?.id);
      dispatch({ type: "SET_SESSION", session });

      // Automatically fire session_start to trigger Turn 1:
      // - story narrator generates opening narrative
      // - init-wizard emits character creation form
      dispatch({ type: "SET_EXECUTING", value: true });
      api.sendAction(
        {
          requestId: api.uid(),
          type: "start_session",
          sessionId: session.id,
          locale: "zh-CN",
          payload: {},
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
  }, [state.presets, handleSseEvent]);

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

    dispatch({ type: "SET_EXECUTING", value: true });
    dispatch({ type: "SET_EXECUTION_ERROR", error: null });

    // Check if it's a slash command
    const isCommand = content.startsWith("/");
    api.sendAction(
      {
        requestId: api.uid(),
        type: isCommand ? "execute_command" : "send_message",
        sessionId: state.session.id,
        locale: "zh-CN",
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

  const executeCommand = useCallback((command: string) => {
    if (!state.session || state.executing) return;

    dispatch({ type: "SET_EXECUTING", value: true });
    dispatch({ type: "SET_EXECUTION_ERROR", error: null });

    api.sendAction(
      {
        requestId: api.uid(),
        type: "execute_command",
        sessionId: state.session.id,
        locale: "zh-CN",
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

  // Boot on mount
  useEffect(() => {
    if (!state.booted && !state.bootError) {
      boot();
    }
  }, [boot, state.booted, state.bootError]);

  const resetSession = useCallback(() => {
    dispatch({ type: "RESET_SESSION" });
  }, []);

  const value: SessionContextValue = {
    state,
    boot,
    initSession,
    sendMessage,
    executeCommand,
    resetSession,
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
