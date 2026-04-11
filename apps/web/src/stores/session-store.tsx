import { createContext, useContext, useReducer, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import i18n from "i18next";
import * as api from "@/services/api";
import { getDataService } from "@/services/data-service";
import { migrateLocalStorageToIdb } from "@/services/app-kv-store";
import { setBlockSchemas } from "@/components/blocks/block-renderer.js";
import { deepMerge } from "@covel/shared";
import type { BlockSchemaDeclaration } from "@covel/shared";
import {
  createSessionSubscription,
  type SessionSubscription,
  type SubscriptionEvent,
} from "@/services/subscription.js";

// ── Types ──────────────────────────────────────────────────────────

export interface StreamMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
  turnId?: string;
  /** Source runtime ID for retry tracking. */
  runtimeId?: string;
  /** Runtime kind (e.g. "story", "plugin") — controls main chat visibility. */
  kind?: string;
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
  /** Turn this step belongs to — enables grouping across multiple turns. */
  turnId?: string;
}

const EXEC_STEPS_MAX = 500;

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

  /** Session-scoped plugin list (active + available). Loaded after session is set. */
  sessionPlugins: api.SessionPluginInfo[];

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

  /** Plugin data keyed by pluginId → namespace → key → value. Updated via plugin-data.changed events. */
  pluginData: Record<string, Record<string, Record<string, unknown>>>;

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
  | { type: "LOAD_EXECUTION_STEPS"; steps: ExecutionStep[] }
  | { type: "CLEAR_EXECUTION_STEPS" }
  | { type: "RESET_SESSION" }
  | { type: "SUBMIT_BLOCK"; blockId: string }
  | { type: "RESET_TO_WORLD_SELECT" }
  | { type: "REMOVE_MESSAGES_FROM_TURN"; turnId: string; keepRuntimeIds: ReadonlySet<string> }
  | { type: "SET_GAME_STATE"; state: Record<string, unknown> }
  | { type: "REMOVE_SESSION"; sessionId: string }
  | { type: "LOAD_SESSION_PLUGINS"; plugins: api.SessionPluginInfo[] }
  | { type: "TOGGLE_SESSION_PLUGIN"; pluginId: string; isActive: boolean }
  | { type: "BACKFILL_TURN_ID"; turnId: string }
  | { type: "PLUGIN_DATA_CHANGED"; pluginId: string; changes: readonly { namespace: string; key: string; value: unknown; operation: string }[] };

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
  pluginData: {},
  submittedBlockIds: new Set<string>(),
  sessionPlugins: [],
};


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
        // Mutate the content string only, create new message + array ref for React
        const prev = state.messages[idx];
        const newMessages = state.messages.with(idx, { ...prev, content: prev.content + action.delta });
        return { ...state, messages: newMessages };
      }
      // Create new streaming message — append without spreading existing array
      return {
        ...state,
        messages: state.messages.concat({
          id: streamId,
          role: "assistant",
          content: action.delta,
          timestamp: new Date().toISOString(),
        }),
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
    case "ADD_EXECUTION_STEP": {
      const raw = [...state.executionSteps, action.step];
      // Cap to prevent unbounded growth
      const updated = raw.length > EXEC_STEPS_MAX ? raw.slice(raw.length - EXEC_STEPS_MAX) : raw;
      return { ...state, executionSteps: updated };
    }
    case "LOAD_EXECUTION_STEPS":
      return { ...state, executionSteps: action.steps };
    case "CLEAR_EXECUTION_STEPS":
      // Only clear in-memory — localStorage is preserved for session history
      return { ...state, executionSteps: [] };
    case "SUBMIT_BLOCK":
      return { ...state, submittedBlockIds: new Set([...state.submittedBlockIds, action.blockId]) };
    case "RESET_SESSION":
      return { ...state, session: null, phase: "init", messages: [], statePatches: [], gameState: {}, pluginData: {}, executing: false, executionError: null, executionSteps: [], submittedBlockIds: new Set<string>(), sessionPlugins: [] };
    case "RESET_TO_WORLD_SELECT":
      return { ...state, world: null, session: null, phase: "init", messages: [], worldSessions: [], statePatches: [], gameState: {}, pluginData: {}, executing: false, executionError: null, executionSteps: [], submittedBlockIds: new Set<string>(), sessionPlugins: [] };
    case "LOAD_SESSION_PLUGINS":
      return { ...state, sessionPlugins: action.plugins };
    case "TOGGLE_SESSION_PLUGIN":
      return {
        ...state,
        sessionPlugins: state.sessionPlugins.map((p) =>
          p.id === action.pluginId ? { ...p, isActive: action.isActive } : p,
        ),
      };
    case "BACKFILL_TURN_ID": {
      // Assign turnId to the last user message that has no turnId.
      // This links the player's input to the server-generated turnId so the
      // execution timeline can be inserted inline after the player message.
      const msgs = state.messages;
      let targetIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user" && !msgs[i].turnId) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx < 0) return state;
      return {
        ...state,
        messages: msgs.map((m, i) =>
          i === targetIdx ? { ...m, turnId: action.turnId } : m,
        ),
      };
    }
    case "REMOVE_MESSAGES_FROM_TURN": {
      // Remove messages from a specific turn, except those from cached runtimes
      const filtered = state.messages.filter((m) => {
        if (m.turnId !== action.turnId) return true;
        if (m.runtimeId && action.keepRuntimeIds.has(m.runtimeId)) return true;
        return false;
      });
      return { ...state, messages: filtered };
    }
    case "PLUGIN_DATA_CHANGED": {
      const { pluginId, changes } = action;
      const prev = state.pluginData;
      const pluginNs = { ...prev[pluginId] };
      for (const change of changes) {
        const ns = { ...pluginNs[change.namespace] };
        if (change.operation === 'delete') {
          delete ns[change.key];
        } else {
          ns[change.key] = change.value;
        }
        pluginNs[change.namespace] = ns;
      }
      return { ...state, pluginData: { ...prev, [pluginId]: pluginNs } };
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
  /** Mark a block as submitted (permanently locks it). */
  submitBlock: (blockId: string) => void;
  /** Submit an interactive block through the submit-inputs API (form/choice/confirmation). */
  submitInteraction: (blockId: string, turnId: string, interactionId: string, type: 'form' | 'choice' | 'confirmation', values: Record<string, unknown>) => Promise<void>;
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
  /** Load the session-scoped plugin list from the server. */
  loadSessionPlugins: () => Promise<void>;
  /** Enable or disable a plugin for the current session (optimistic update). */
  toggleSessionPlugin: (pluginId: string, enable: boolean) => Promise<void>;
  /** Trigger a custom kernel event (e.g. image generation from a message button). */
  triggerEvent: (eventType: string, eventData: Record<string, unknown>) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const ds = useMemo(() => getDataService(), []);

  // Ref to track current session ID for use in callbacks (avoids stale closures)
  const sessionIdRef = useRef<string | null>(null);
  // Track runtime kind (story vs plugin) so we can filter non-story text from main chat
  const runtimeKindRef = useRef<Map<string, string>>(new Map());
  // Batch streaming deltas: accumulate per-runtime and flush once per animation frame
  const deltaBufferRef = useRef<Map<string, { turnId: string; runtimeId: string; pluginId: string; text: string }>>(new Map());
  const deltaRafRef = useRef<number | null>(null);
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
            const validKeys: Record<string, string> = {};
            for (const [k, v] of Object.entries(keys)) {
              if (typeof k === "string" && typeof v === "string" && k.length <= 64 && v.length <= 256) {
                validKeys[k] = v;
              }
            }
            const existing = api.getProviderKeys();
            if (Object.keys(existing).length === 0 && Object.keys(validKeys).length > 0) {
              api.setProviderKeys(validKeys);
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

  const lastBackfilledTurnIdRef = useRef<string | null>(null);

  // ── Primary SSE Event Handler (/actions SSE) ──────────────────
  // Single handler for ALL in-turn data updates. Every piece of UI state
  // is updated through this handler during turn execution:
  //
  //   Narrative:  narrative.delta → narrative.completed → interaction.requested
  //   State:      state.changed → gameState deep-merge
  //   Events:     event.emitted → gameState.events
  //   Records:    record.updated → gameState.records
  //   Phase:      phase.changed → session phase
  //   Execution:  execution.started → runtime.started → runtime.completed → execution.completed
  //   Error:      error.occurred
  //
  const handleSseEvent = useCallback((envelope: api.SseEnvelope) => {
    const { type, payload, turnId } = envelope;

    // Backfill turnId on the most recent user message so execution timelines
    // render inline after the player's input instead of stacking at the bottom.
    if (turnId && turnId !== lastBackfilledTurnIdRef.current) {
      lastBackfilledTurnIdRef.current = turnId;
      dispatch({ type: "BACKFILL_TURN_ID", turnId });
    }

    switch (type) {
      // ── Narrative events ──────────────────────────────────────
      case "narrative.delta":
      case "message.delta": {
        const delta = (payload.delta as string) ?? "";
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const pluginId = (payload.pluginId as string) ?? "";
        // Only show story-kind runtime text in main chat; plugin text goes to debug only
        const deltaKind = (payload.kind as string) ?? runtimeKindRef.current.get(runtimeId);
        if (delta && deltaKind === "story") {
          // Buffer deltas and flush once per animation frame to avoid per-token array copies
          const bufKey = `${turnId ?? "unknown"}_${runtimeId}`;
          const existing = deltaBufferRef.current.get(bufKey);
          if (existing) {
            existing.text += delta;
          } else {
            deltaBufferRef.current.set(bufKey, { turnId: turnId ?? "unknown", runtimeId, pluginId, text: delta });
          }
          if (deltaRafRef.current === null) {
            deltaRafRef.current = requestAnimationFrame(() => {
              for (const entry of deltaBufferRef.current.values()) {
                dispatch({ type: "APPEND_DELTA", turnId: entry.turnId, runtimeId: entry.runtimeId, pluginId: entry.pluginId, delta: entry.text });
              }
              deltaBufferRef.current.clear();
              deltaRafRef.current = null;
            });
          }
        }
        break;
      }
      case "narrative.completed":
      case "message.completed": {
        // When streaming is active, message.completed duplicates streamed content.
        // Dispatch a deduplicated action — the reducer checks for existing stream messages.
        const content = (payload.content as string) ?? "";
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const msgId = (payload.messageId as string) ?? api.uid();

        // Display in main chat: story-kind runtime text
        // Prefer kind from SSE payload, fall back to runtimeKindRef
        const completedKind = (payload.kind as string) ?? runtimeKindRef.current.get(runtimeId);
        if (content && completedKind === "story") {
          const msg: StreamMessage = {
            id: msgId,
            role: "assistant",
            content,
            timestamp: envelope.timestamp,
            turnId,
            runtimeId: runtimeId !== "unknown" ? runtimeId : undefined,
          };
          dispatch({ type: "COMPLETE_MESSAGE", turnId: turnId ?? "unknown", runtimeId, message: msg });
        }

        // Always persist to IDB regardless of kind — ensures full session restore on refresh.
        // Store the kind so restore can filter display correctly.
        if (content) {
          const sid = sessionIdRef.current;
          if (sid) {
            ds.addMessage({
              id: msgId,
              sessionId: sid,
              role: "assistant",
              content,
              turnId,
              runtimeId: runtimeId !== "unknown" ? runtimeId : undefined,
              kind: completedKind,
              createdAt: envelope.timestamp,
            }).catch(() => {});
          }
        }
        break;
      }
      // ── Interaction events ────────────────────────────────────
      case "interaction.requested":
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
      // ── State events ─────────────────────────────────────────
      case "state.changed":
      case "state.patch.applied": {
        // Session Kernel sends: { table, field, value, runtimeId, pluginId }
        // Legacy format: { patch: { id, summary, packageName, data } }
        const table = payload.table as string | undefined;
        const field = payload.field as string | undefined;
        const value = payload.value;
        const legacyPatch = payload.patch as { id: string; summary: string; packageName: string; data?: unknown } | undefined;

        const patch = legacyPatch ?? {
          id: `sp_${Date.now()}`,
          summary: field ? `${table ?? "default"}.${field}` : "state change",
          packageName: (payload.pluginId as string) ?? "system",
          data: field ? { [field]: value } : undefined,
        };

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
              .catch((e: unknown) => console.warn("[session] persistStateSnapshot failed:", e));
          }
        }
        break;
      }
      // ── Session lifecycle events ─────────────────────────────
      case "phase.changed":
      case "phase_change": {
        const phase = payload.phase as api.SessionPhase;
        if (phase) {
          dispatch({ type: "SET_PHASE", phase });
          // Persist phase to IDB session record so it survives refresh
          const sid = sessionIdRef.current;
          if (sid) {
            ds.updateSession(sid, { phase }).catch(() => {});
          }
        }
        break;
      }
      // ── Execution lifecycle events ───────────────────────────
      case "execution.started": {
        // Turn-level execution started — tracked by `executing` flag, no fake runtime step needed
        break;
      }
      case "runtime.started": {
        const step: ExecutionStep = {
          type: "runtime.started",
          runtimeId: (payload.runtimeId as string) ?? "unknown",
          pluginId: (payload.pluginId as string) ?? "",
          label: payload.label as string | undefined,
          timestamp: envelope.timestamp,
          turnId,
        };
        // Track runtime kind from label (format: "pluginId/kind")
        if (step.label) {
          const slashIdx = step.label.indexOf("/");
          if (slashIdx >= 0) {
            runtimeKindRef.current.set(step.runtimeId, step.label.slice(slashIdx + 1));
          }
        }
        dispatch({ type: "ADD_EXECUTION_STEP", step });
        break;
      }
      case "runtime.completed": {
        dispatch({ type: "ADD_EXECUTION_STEP", step: {
          type: "runtime.completed",
          runtimeId: (payload.runtimeId as string) ?? "unknown",
          pluginId: (payload.pluginId as string) ?? "",
          detail: payload.durationMs != null ? `${payload.durationMs}ms` : undefined,
          timestamp: envelope.timestamp,
          turnId,
        }});
        break;
      }
      case "runtime.failed": {
        dispatch({ type: "ADD_EXECUTION_STEP", step: {
          type: "runtime.failed",
          runtimeId: (payload.runtimeId as string) ?? "unknown",
          pluginId: (payload.pluginId as string) ?? "",
          detail: payload.error as string | undefined,
          timestamp: envelope.timestamp,
          turnId,
        }});
        break;
      }
      case "execution.completed": {
        dispatch({ type: "SET_EXECUTING", value: false });
        break;
      }
      // Legacy compat — remove once all servers emit protocol types
      case "runtime.progress": {
        const statusToType: Record<string, ExecutionStep["type"]> = {
          started: "runtime.started",
          completed: "runtime.completed",
          skipped: "runtime.completed",
          failed: "runtime.failed",
          executing: "runtime.started",
        };
        const stepType = statusToType[payload.status as string] ?? (payload.type as ExecutionStep["type"]);
        if (stepType) {
          const step: ExecutionStep = {
            type: stepType,
            runtimeId: (payload.runtimeId as string) ?? "__turn__",
            pluginId: (payload.pluginId as string) ?? "",
            label: payload.label as string | undefined,
            detail: payload.durationMs != null ? `${payload.durationMs}ms` : undefined,
            timestamp: envelope.timestamp,
            turnId,
          };
          if (step.type === "runtime.started" && step.label) {
            const slashIdx = step.label.indexOf("/");
            if (slashIdx >= 0) {
              runtimeKindRef.current.set(step.runtimeId, step.label.slice(slashIdx + 1));
            }
          }
          dispatch({ type: "ADD_EXECUTION_STEP", step });
        }
        break;
      }
      case "event.emitted": {
        // Merge emitted game events into gameState.events array
        const topic = (payload.topic as string) ?? (payload.type as string);
        const eventData = payload.data ?? payload;
        if (topic) {
          dispatch({
            type: "ADD_STATE_PATCH",
            patch: {
              id: `evt_${Date.now()}`,
              summary: `event: ${topic}`,
              packageName: (payload.pluginId as string) ?? "system",
              data: {
                events: [{
                  id: `evt_${Date.now()}`,
                  title: topic,
                  type: (payload.eventType as string) ?? topic,
                  status: "active",
                  description: typeof eventData === "object" ? JSON.stringify(eventData) : String(eventData),
                  turnCreated: turnId ? parseInt(turnId.split("-").pop() ?? "0", 10) : undefined,
                }],
              },
            },
          });
        }
        break;
      }
      case "record.updated": {
        // Merge record updates into gameState.records
        const recordType = (payload.recordType as string) ?? (payload.type as string);
        const recordKey = (payload.key as string) ?? (payload.id as string);
        if (recordKey) {
          dispatch({
            type: "ADD_STATE_PATCH",
            patch: {
              id: `rec_${Date.now()}`,
              summary: `record: ${recordType ?? "update"} ${recordKey}`,
              packageName: (payload.pluginId as string) ?? "system",
              data: {
                records: { [recordKey]: payload.value ?? payload },
              },
            },
          });
        }
        break;
      }
      // ── Plugin data events ────────────────────────────────────
      case "plugin-data.changed": {
        const pluginId = payload.pluginId as string;
        const changes = payload.changes as readonly { namespace: string; key: string; value: unknown; operation: string }[];
        if (pluginId && changes) {
          dispatch({ type: "PLUGIN_DATA_CHANGED", pluginId, changes });
        }
        break;
      }
      // ── Error events ──────────────────────────────────────────
      case "error.occurred":
      case "flow.failed": {
        dispatch({ type: "SET_EXECUTION_ERROR", error: (payload.message as string) ?? "Execution failed" });
        dispatch({ type: "SET_EXECUTING", value: false });
        break;
      }
      // Legacy compat
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

  /**
   * Create a new session and enter GameView — does NOT start the narrative.
   * The player presses "开始冒险" inside GameView to actually kick off the LLM flow.
   */
  const startGame = useCallback(async () => {
    if (!state.world) return;
    try {
      const slotConfig = api.getSlotConfig();
      const configuredSlotIds = state.llmConfig?.configured
        ? Object.keys(state.llmConfig.slots)
        : [];
      const primarySlotId = configuredSlotIds[0];
      const primaryPresetId = primarySlotId
        ? slotConfig[primarySlotId]?.presetId ?? `slot-${primarySlotId}`
        : undefined;
      const defaultPresetId = slotConfig.default?.presetId;
      const presetId = primaryPresetId
        ?? defaultPresetId
        ?? state.presets.find((p) => p.isDefault)?.id
        ?? state.presets[0]?.id;
      const session = await ds.createSession(state.world.id, presetId);
      dispatch({ type: "SET_SESSION", session });
      // Copy prep-phase runtime bindings to the real session
      const prepBindings = api.getRuntimeBindings(`prep:${state.world.id}`);
      if (Object.keys(prepBindings).length > 0) {
        api.setRuntimeBindings(session.id, prepBindings);
      }
      // Sync context to server so the stateless server can process the first turn
      await ds.syncToServer(session.id);
      api.markServerAck();
    } catch (err) {
      dispatch({ type: "SET_EXECUTION_ERROR", error: (err as Error).message });
    }
  }, [state.world, state.presets, state.llmConfig]);

  /** Send the start_session action to kick off the narrative. Called from GameView. */
  const beginAdventure = useCallback(() => {
    if (!state.session || state.executing) return;
    const sessionId = state.session.id;
    void api.getWorldOverlay(state.world?.id ?? "").then((overlay) => {
      const loreOverride = overlay?.lore;
      dispatch({ type: "SET_EXECUTING", value: true });
      api.sendAction(
        {
          requestId: api.uid(),
          type: "start_session",
          sessionId,
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
    }).catch(() => {
      // Proceed without overlay if fetch fails
      dispatch({ type: "SET_EXECUTING", value: true });
      api.sendAction(
        {
          requestId: api.uid(),
          type: "start_session",
          sessionId,
          locale: i18n.language,
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
    });
  }, [state.session, state.world, state.executing, handleSseEvent]);

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

    // Guard: track intended session ID so stale async results are discarded
    const targetSessionId = session.id;
    sessionIdRef.current = targetSessionId;

    // Load messages, state patches, and state snapshot in parallel
    const [messagesResult, patchesResult, snapshotResult] = await Promise.allSettled([
      ds.listMessages(session.id),
      ds.listStatePatches(session.id),
      ds.loadStateSnapshot(session.id),
    ]);

    // Discard if session changed during async loading
    if (sessionIdRef.current !== targetSessionId) return;

    // Restore messages (including block data)
    if (messagesResult.status === "fulfilled") {
      const streamMessages: StreamMessage[] = messagesResult.value.map((m) => ({
        id: m.id,
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
        timestamp: m.createdAt,
        turnId: m.turnId,
        runtimeId: m.runtimeId,
        kind: m.kind,
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

    // Load characters and execution steps from snapshot API for complete restore
    try {
      const snapshot = await api.getSessionSnapshot(session.id);
      if (sessionIdRef.current !== targetSessionId) return;
      if (snapshot.characters.length > 0 || Object.keys(snapshot.gameState).length > 0 || snapshot.characterSchema) {
        const enrichedState: Record<string, unknown> = {
          ...snapshot.gameState,
          characters: snapshot.characters,
        };
        // Persist character schema for right panel rendering
        if (snapshot.characterSchema) {
          enrichedState.characterSchema = snapshot.characterSchema;
        }
        dispatch({ type: "SET_GAME_STATE", state: enrichedState });
      }
      // Restore execution steps from trace events
      if (snapshot.executionSteps.length > 0) {
        const steps = snapshot.executionSteps
          .filter(s => s.type.startsWith('runtime.'))
          .map(s => {
            const p = s.payload as Record<string, unknown>;
            return {
              type: s.type as "runtime.started" | "runtime.completed" | "runtime.failed",
              runtimeId: (p.runtimeId as string) ?? '',
              pluginId: (p.pluginId as string) ?? '',
              timestamp: s.timestamp,
              turnId: s.turnId,
              detail: (p.durationMs != null) ? `${p.durationMs}ms` : undefined,
            };
          })
          .filter(s => s.runtimeId !== '__turn__');
        dispatch({ type: "LOAD_EXECUTION_STEPS", steps });
      }
    } catch {
      // Snapshot API not critical — game can still work without it
    }

    // Discard if session changed during restore
    if (sessionIdRef.current !== targetSessionId) return;

    // Restore submitted block IDs via DataService
    try {
      const blockIds = await ds.loadSubmittedBlocks(session.id);
      if (sessionIdRef.current !== targetSessionId) return;
      for (const blockId of blockIds) {
        dispatch({ type: "SUBMIT_BLOCK", blockId });
      }
    } catch { /* ignore load errors */ }

    // Restore accumulated execution steps from DataService (persisted across refreshes)
    try {
      const steps = (await ds.loadExecutionSteps(session.id)) as ExecutionStep[];
      if (sessionIdRef.current !== targetSessionId) return;
      if (steps.length > 0) {
        for (const step of steps) {
          dispatch({ type: "ADD_EXECUTION_STEP", step });
        }
      }
    } catch { /* ignore load errors */ }

    // Load session-scoped plugins so right panel can discover world-data-provider.
    // loadSessionPlugins is defined later in the hook, so call the API directly here.
    api.listSessionPlugins(session.id).then((res) => {
      if (sessionIdRef.current === targetSessionId) {
        dispatch({ type: "LOAD_SESSION_PLUGINS", plugins: res.available });
      }
    }).catch(() => {});

    // Sync session context to server so subsequent turns can be processed
    ds.syncToServer(session.id).then(() => {
      if (sessionIdRef.current === targetSessionId) {
        api.markServerAck();
      }
    }).catch((err: unknown) => {
      console.warn("[session] syncToServer failed:", err);
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
    api.clearRuntimeBindings(sessionId);
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
    // Persist via DataService so submitted state survives refresh
    const sid = sessionIdRef.current;
    if (sid) {
      ds.loadSubmittedBlocks(sid).then((existing) => {
        if (!existing.includes(blockId)) {
          ds.saveSubmittedBlocks(sid, [...existing, blockId]).catch(() => {});
        }
      }).catch(() => {});
    }
  }, []);

  /**
   * Submit an interactive block through the submit-inputs API.
   * This handles: template filling, CharacterRecord creation, phase transition.
   * After submission, triggers the next turn with the filled narrative.
   */
  const submitInteraction = useCallback(async (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: 'form' | 'choice' | 'confirmation',
    values: Record<string, unknown>,
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;

    try {
      // 1. Mark block as submitted (UI lock)
      submitBlock(blockId);

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

      // 4. Use filled narrative to trigger next turn
      const filled = result.results?.[0]?.filledNarrative;
      if (filled) {
        sendMessage(filled);
      }
    } catch (err) {
      console.error('[submitInteraction] Failed:', err);
      // Still send raw values as fallback
      const rawContent = Object.values(values).join(', ');
      sendMessage(rawContent);
    }
  }, [submitBlock, sendMessage]);

  const executeCommand = useCallback((command: string) => {
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

  // Persist execution steps to DataService whenever they change
  useEffect(() => {
    const sid = state.session?.id;
    if (!sid || state.executionSteps.length === 0) return;
    ds.saveExecutionSteps(sid, state.executionSteps).catch(() => {});
  }, [state.executionSteps, state.session?.id, ds]);

  // ── Persistent SSE subscription for out-of-band events ──────
  //
  // Architecture: TWO SSE channels with clear separation of concerns:
  //
  // Channel 1 — /actions SSE (per-turn, handleSseEvent):
  //   Primary path for ALL in-turn data. Handles: message streaming,
  //   blocks, state patches, events, records, phase changes, execution steps.
  //   Active only during turn execution; closes when turn completes.
  //
  // Channel 2 — /events/stream (persistent, handleSubscriptionEvent):
  //   Handles ONLY out-of-band events that happen outside of turn execution:
  //   plugin enable/disable, external state changes from other clients.
  //   Does NOT duplicate in-turn events (no runtime.*, no state.*, no phase.*).
  //
  const subscriptionRef = useRef<SessionSubscription | null>(null);

  useEffect(() => {
    const sid = state.session?.id;
    if (!sid) {
      if (subscriptionRef.current) {
        subscriptionRef.current.close();
        subscriptionRef.current = null;
      }
      return;
    }

    if (subscriptionRef.current) {
      subscriptionRef.current.close();
    }

    const sub = createSessionSubscription(sid, {
      topics: ["plugin", "system"],
    });
    subscriptionRef.current = sub;

    const handleSubscriptionEvent = (event: SubscriptionEvent) => {
      switch (event.type) {
        case "plugin.activated":
        case "plugin.deactivated": {
          // Reload session plugins from server to get fresh state
          const currentSid = sessionIdRef.current;
          if (currentSid) {
            api.listSessionPlugins(currentSid)
              .then((res) => dispatch({ type: "LOAD_SESSION_PLUGINS", plugins: res.available }))
              .catch(() => {});
          }
          break;
        }
        case "world.dimensions.changed": {
          // Refresh world data from server so UI can prompt sync
          const worldId = event.payload?.worldId as string | undefined;
          if (worldId) {
            api.getWorld(worldId)
              .then((world) => dispatch({ type: "UPDATE_WORLD", world }))
              .catch(() => {});
          }
          break;
        }
        default:
          break;
      }
    };

    sub.on("*", handleSubscriptionEvent);

    return () => {
      sub.close();
      subscriptionRef.current = null;
    };
  }, [state.session?.id]);

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

  const toggleSessionPlugin = useCallback(async (pluginId: string, enable: boolean) => {
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
      dispatch({ type: "TOGGLE_SESSION_PLUGIN", pluginId, isActive: !enable });
    }
  }, []);

  const triggerEvent = useCallback((eventType: string, eventData: Record<string, unknown>) => {
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
    loadSessionPlugins,
    toggleSessionPlugin,
    triggerEvent,
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
