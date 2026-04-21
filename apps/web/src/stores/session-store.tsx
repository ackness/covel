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
import {
  applyChanges as applyPluginDataStoreChanges,
  resetPluginData,
  setActiveSession as setActivePluginDataSession,
  type PluginDataChange,
} from "@/stores/plugin-data-store.js";
import { emitToast } from "@/lib/toast-channel.js";

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

/**
 * Aggregated runtime status — ONE row per (turnId, runtimeId).
 *
 * Previously this was an append-only event log where every runtime.started /
 * runtime.completed / runtime.failed / llm.calling was pushed as a new step,
 * and `deriveStatuses` in execution-timeline had to scan the log to derive
 * the current status. That design cannot distinguish "event hasn't arrived
 * yet" from "event was lost / reordered" — any dropped runtime.completed
 * left the chip spinning forever.
 *
 * V2 uses a status-aggregation model: each runtime has a single row, and
 * every SSE event upserts the status in-place. A missed event still leaves
 * the row in the best known state, and the next arriving event overwrites
 * cleanly. That is what we adopt here to keep chips from getting stuck.
 */
export interface ExecutionStep {
  runtimeId: string;
  pluginId: string;
  status: "running" | "llm" | "tool" | "completed" | "failed" | "skipped";
  label?: string;
  detail?: string;
  /** Qualified tool name when status is "tool". */
  toolName?: string;
  durationMs?: number;
  /** Turn this step belongs to — enables grouping across multiple turns. */
  turnId?: string;
  /** Wall-clock start time (for on-device duration fallback). */
  startedAt?: string;
}

const EXEC_STEPS_MAX = 500;

/**
 * Legacy phase strings still consumed by the V1 chat/game-view UI. Produced
 * from `SessionRecord.status` + `SessionRecord.turnCount` via `toLegacyPhase`.
 */
export type LegacyPhase = "init" | "playing" | "paused" | "ended";

function toLegacyPhase(session: Pick<api.SessionRecord, "status" | "turnCount"> | null | undefined): LegacyPhase {
  if (!session) return "init";
  if (session.status === "ended") return "ended";
  if (session.status === "paused") return "paused";
  return (session.turnCount ?? 0) >= 1 ? "playing" : "init";
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

  /** Session-scoped plugin list (active + available). Loaded after session is set. */
  sessionPlugins: api.SessionPluginInfo[];

  // Active session
  world: api.WorldRecord | null;
  session: api.SessionRecord | null;
  /**
   * Legacy display phase derived from session (`status`, `turnCount`).
   *
   * The turn-band refactor replaced the per-session phase enum with a coarser
   * `status` + `turnCount` pair. UI surfaces that still speak the old phase
   * vocabulary ("init", "playing", "ended", …) read this derived value so
   * they can keep rendering phase-specific empty states without each
   * component re-implementing the mapping.
   */
  phase: LegacyPhase;
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

  /**
   * Message-slot UI specs loaded from /api/ui-specs. Each entry contributes
   * one or more json-render spec trees for the plugin-message surface. Plugins
   * push data to their `namespace: "message"` plugin-data and the frontend
   * materialises a synthetic `plugin_message` block using these specs.
   */
  messageUiSpecs: api.UISlotEntry[];

  /**
   * Pending interaction drafts (choice selections, suggestion picks, etc.)
   * staged by the player before confirmation. Cleared on turn submission,
   * session reset, or explicit dismissal.
   */
  pendingInteractionDrafts: PendingInteractionDraft[];

  /** Block IDs that have been submitted by the player (permanently locked). */
  submittedBlockIds: ReadonlySet<string>;

  /**
   * Form values keyed by submitted block id. Used to repopulate disabled
   * forms so the player can still see what they originally entered.
   */
  submittedBlockValues: Readonly<Record<string, Record<string, unknown>>>;
}

export interface PendingInteractionDraft {
  id: string;
  turnId: string;
  interactionId: string;
  type: "form" | "choice" | "confirmation" | "suggestion";
  label: string;
  values: Record<string, unknown>;
  /**
   * StreamMessage id of the block that produced this draft. When the player
   * confirms drafts, the framework stamps the block as submitted and
   * records the player's chosen labels — so re-rendering the disabled
   * block can show the historical selection. Optional for backward
   * compatibility with drafts that originate outside a block (e.g. composer-only).
   */
  sourceBlockId?: string;
  selectionGroup?: string;
  submitBehavior?: { echoFilledNarrative?: boolean };
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
  | { type: "SET_PHASE"; phase: LegacyPhase }
  | { type: "UPSERT_EXECUTION_STEP"; step: ExecutionStep }
  | { type: "LOAD_EXECUTION_STEPS"; steps: ExecutionStep[] }
  | { type: "CLEAR_EXECUTION_STEPS" }
  | { type: "FINALIZE_HANGING_RUNTIMES"; reason: string }
  | { type: "RESET_SESSION" }
  | { type: "SUBMIT_BLOCK"; blockId: string; values?: Record<string, unknown> }
  | { type: "RESET_TO_WORLD_SELECT" }
  | { type: "REMOVE_MESSAGES_FROM_TURN"; turnId: string; keepRuntimeIds: ReadonlySet<string> }
  | { type: "SET_GAME_STATE"; state: Record<string, unknown> }
  | { type: "REMOVE_SESSION"; sessionId: string }
  | { type: "LOAD_SESSION_PLUGINS"; plugins: api.SessionPluginInfo[] }
  | { type: "TOGGLE_SESSION_PLUGIN"; pluginId: string; isActive: boolean }
  | { type: "BACKFILL_TURN_ID"; turnId: string }
  | { type: "PLUGIN_DATA_CHANGED"; pluginId: string; changes: readonly { namespace: string; key: string; value: unknown; operation: string }[] }
  | { type: "LOAD_MESSAGE_UI_SPECS"; specs: api.UISlotEntry[] }
  | { type: "UPSERT_PLUGIN_MESSAGE_SURFACE"; pluginId: string }
  | { type: "UPSERT_DRAFT"; draft: PendingInteractionDraft }
  | { type: "REMOVE_DRAFT"; draftId: string }
  | { type: "CLEAR_DRAFTS" };

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
  submittedBlockValues: {},
  sessionPlugins: [],
  messageUiSpecs: [],
  pendingInteractionDrafts: [],
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
      return { ...state, session: action.session, phase: toLegacyPhase(action.session) };
    case "SET_WORLD_SESSIONS":
      return { ...state, worldSessions: action.sessions };
    case "REMOVE_SESSION":
      return { ...state, worldSessions: state.worldSessions.filter((s) => s.id !== action.sessionId) };
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "COMPLETE_MESSAGE": {
      // Replace the streaming placeholder with the final message content.
      // Previously we skipped when a placeholder existed — but if any delta
      // frames were dropped mid-stream the placeholder only contains the
      // partial text the client received, and the user saw a truncated
      // narrative. V2 replaces the placeholder with the completed content,
      // which is always the authoritative full text; mirror that here.
      const streamId = `stream_${action.turnId}_${action.runtimeId}`;
      const idx = state.messages.findIndex((m) => m.id === streamId);
      if (idx >= 0) {
        const next = [...state.messages];
        next[idx] = { ...action.message, id: state.messages[idx].id, kind: "story" };
        return { ...state, messages: next };
      }
      return { ...state, messages: [...state.messages, { ...action.message, kind: "story" }] };
    }
    case "APPEND_DELTA": {
      // Find existing streaming message for this runtime, or create one.
      // IMPORTANT: carry turnId / runtimeId / kind on the placeholder from the
      // first delta — chat-messages groups execution timelines by turnId and
      // without these fields each streaming story message would be treated as
      // "unattributed" and the timeline chips would jump to the very top of
      // the chat instead of appearing right after the turn's last message.
      const streamId = `stream_${action.turnId}_${action.runtimeId}`;
      const idx = state.messages.findIndex((m) => m.id === streamId);
      if (idx >= 0) {
        const prev = state.messages[idx];
        const newMessages = state.messages.with(idx, { ...prev, content: prev.content + action.delta });
        return { ...state, messages: newMessages };
      }
      return {
        ...state,
        messages: state.messages.concat({
          id: streamId,
          role: "assistant",
          content: action.delta,
          timestamp: new Date().toISOString(),
          turnId: action.turnId,
          runtimeId: action.runtimeId,
          kind: "story",
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
    case "LOAD_MESSAGES": {
      // LOAD_MESSAGES overwrites `messages` with the server snapshot, so any
      // plugin-message entries previously synthesised from plugin-data hydration
      // would be wiped. Re-apply the surface for every plugin that declared a
      // `ui.message` spec AND already has populated namespace state. Without
      // this, plugins whose only chat output is the json-render surface (e.g.
      // core-guide) never show up on page refresh after hydration+snapshot
      // race to completion in the unfavourable order.
      let nextState: SessionState = { ...state, messages: action.messages };
      for (const entry of nextState.messageUiSpecs) {
        if (nextState.pluginData[entry.pluginId]?.message) {
          nextState = applyPluginMessageSurface(nextState, entry.pluginId);
        }
      }
      return nextState;
    }
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
    case "UPSERT_EXECUTION_STEP": {
      // Upsert on (turnId, runtimeId). Transitions running → completed/failed/
      // skipped / etc happen in place — missed runtime.completed no longer
      // leaves the chip spinning. New turn creates a new row; existing turn's
      // row is merged so we keep label/startedAt while overwriting status.
      const key = `${action.step.turnId ?? "__no_turn__"}|${action.step.runtimeId}`;
      const idx = state.executionSteps.findIndex(
        (s) => `${s.turnId ?? "__no_turn__"}|${s.runtimeId}` === key,
      );
      const next = [...state.executionSteps];
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...action.step };
      } else {
        next.push(action.step);
      }
      const capped = next.length > EXEC_STEPS_MAX ? next.slice(next.length - EXEC_STEPS_MAX) : next;
      return { ...state, executionSteps: capped };
    }
    case "LOAD_EXECUTION_STEPS":
      return { ...state, executionSteps: action.steps };
    case "FINALIZE_HANGING_RUNTIMES": {
      // Backend runtimes whose LLM call hangs never emit runtime.completed —
      // the executor's timeoutMs is a loop guard, not an HTTP AbortSignal,
      // so /api/actions eventually returns (or is cancelled) while chips
      // remain "running" forever. When the action stream is known to have
      // ended, flip any still-running chip to "failed" so the UI stops
      // pretending work is in progress.
      const anyRunning = state.executionSteps.some(
        (s) => s.status === "running" || s.status === "llm" || s.status === "tool",
      );
      if (!anyRunning) return state;
      return {
        ...state,
        executionSteps: state.executionSteps.map((s) =>
          s.status === "running" || s.status === "llm" || s.status === "tool"
            ? { ...s, status: "failed", detail: s.detail ?? action.reason }
            : s,
        ),
      };
    }
    case "CLEAR_EXECUTION_STEPS":
      // Only clear in-memory — localStorage is preserved for session history
      return { ...state, executionSteps: [] };
    case "SUBMIT_BLOCK":
      return {
        ...state,
        submittedBlockIds: new Set([...state.submittedBlockIds, action.blockId]),
        submittedBlockValues: action.values
          ? { ...state.submittedBlockValues, [action.blockId]: action.values }
          : state.submittedBlockValues,
      };
    case "RESET_SESSION":
      return { ...state, session: null, phase: "init", messages: [], statePatches: [], gameState: {}, pluginData: {}, executing: false, executionError: null, executionSteps: [], submittedBlockIds: new Set<string>(), submittedBlockValues: {}, sessionPlugins: [], messageUiSpecs: [], pendingInteractionDrafts: [] };
    case "RESET_TO_WORLD_SELECT":
      return { ...state, world: null, session: null, phase: "init", messages: [], worldSessions: [], statePatches: [], gameState: {}, pluginData: {}, executing: false, executionError: null, executionSteps: [], submittedBlockIds: new Set<string>(), submittedBlockValues: {}, sessionPlugins: [], messageUiSpecs: [], pendingInteractionDrafts: [] };
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
      const nextState = { ...state, pluginData: { ...prev, [pluginId]: pluginNs } };
      // If any change touched namespace="message", refresh the synthesized
      // plugin_message surface for this plugin so chat can render it via json-render.
      if (changes.some((c) => c.namespace === 'message')) {
        return applyPluginMessageSurface(nextState, pluginId);
      }
      return nextState;
    }
    case "LOAD_MESSAGE_UI_SPECS":
      return { ...state, messageUiSpecs: action.specs };
    case "UPSERT_PLUGIN_MESSAGE_SURFACE":
      return applyPluginMessageSurface(state, action.pluginId);
    case "UPSERT_DRAFT": {
      const { draft } = action;
      const filtered = state.pendingInteractionDrafts.filter((d) =>
        d.id !== draft.id &&
        !(draft.selectionGroup && d.turnId === draft.turnId && d.selectionGroup === draft.selectionGroup),
      );
      return { ...state, pendingInteractionDrafts: [...filtered, draft] };
    }
    case "REMOVE_DRAFT":
      return { ...state, pendingInteractionDrafts: state.pendingInteractionDrafts.filter((d) => d.id !== action.draftId) };
    case "CLEAR_DRAFTS":
      return { ...state, pendingInteractionDrafts: [] };
    default:
      return state;
  }
}

// ── Plugin message surface ─────────────────────────────────────────
//
// Synthesize a StreamMessage with a `plugin_message` block whenever the plugin
// writes to its `namespace: "message"` plugin-data. The block carries the json-
// render spec(s) the plugin declared in its manifest's `ui.message`, plus the
// current namespace snapshot as `state`. MessageRenderer then loops over specs
// and hands each one to <PluginPanel> to render via json-render.

function stripPrivateMessageKeys(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('__')));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyPluginMessageSurface(state: SessionState, pluginId: string): SessionState {
  const uiEntry = state.messageUiSpecs.find((entry) => entry.pluginId === pluginId);
  if (!uiEntry || uiEntry.specs.length === 0) return state;

  const namespaceState = state.pluginData[pluginId]?.message ?? {};
  const turnId = typeof namespaceState.__turnId === 'string' ? namespaceState.__turnId : '';
  if (!turnId) return state;

  const blockState = stripPrivateMessageKeys(namespaceState);
  const messageId = `plugin-message:${pluginId}:${turnId}`;
  const block = {
    type: 'plugin_message',
    data: {
      pluginId,
      specs: cloneJson(uiEntry.specs) as unknown,
      state: cloneJson(blockState),
    },
    meta: { pluginId, turnId },
  } as Record<string, unknown>;

  const messages = state.messages;
  const existingIdx = messages.findIndex((m) => m.id === messageId);
  if (existingIdx >= 0) {
    const next = [...messages];
    next[existingIdx] = {
      ...next[existingIdx],
      block,
      timestamp: new Date().toISOString(),
    };
    return { ...state, messages: next };
  }

  const nextMessage: StreamMessage = {
    id: messageId,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    turnId,
    kind: 'plugin-message',
    block,
    runtimeId: pluginId,
  };

  // Anchor after the latest story/plugin-message from the same turn so that
  // plugin surfaces follow the narrative they augment.
  let anchorIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.turnId === turnId && (m.kind === 'story' || m.kind === 'plugin-message')) {
      anchorIndex = i;
      break;
    }
  }
  const next = [...messages];
  if (anchorIndex < 0) next.push(nextMessage);
  else next.splice(anchorIndex + 1, 0, nextMessage);

  return { ...state, messages: next };
}

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
    type: 'form' | 'choice' | 'confirmation',
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
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const ds = useMemo(() => getDataService(), []);

  // Ref to track current session ID for use in callbacks (avoids stale closures)
  const sessionIdRef = useRef<string | null>(null);
  // Track runtime kind (story vs plugin) so we can filter non-story text from main chat
  const runtimeKindRef = useRef<Map<string, string>>(new Map());
  // Batch streaming deltas: accumulate per-runtime and flush once per animation frame.
  // `flushSessionId` is captured at push time so a session switch mid-stream causes
  // the RAF to drop stale entries instead of bleeding them into the new session.
  const deltaBufferRef = useRef<Map<string, { turnId: string; runtimeId: string; pluginId: string; text: string; flushSessionId: string | null }>>(new Map());
  const deltaRafRef = useRef<number | null>(null);
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
    if (deltaRafRef.current !== null) {
      cancelAnimationFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    deltaBufferRef.current.clear();
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
      // Register plugin-declared user settings from PLUGIN.md frontmatter.
      // Each plugin with `userSettings:` shows up under Plugins > <pluginId>
      // in the Settings UI, with values stored under `plugin.<pluginId>.<key>`.
      const { registerPluginUserSettings } = await import(
        "@/settings/registry/plugin.js"
      );
      const { getSettings } = await import("@/settings/store.js");
      for (const pkg of packagesRes.packages) {
        if (pkg.userSettings && pkg.userSettings.length > 0) {
          registerPluginUserSettings(
            getSettings(),
            pkg.name,
            pkg.userSettings,
          );
        }
      }
      // Register known providers discovered from llm.toml so the Settings UI
      // shows a secret input per provider.
      if (llmConfig?.providers && llmConfig.providers.length > 0) {
        const { registerKnownProviders } = await import(
          "@/settings/store.js"
        );
        registerKnownProviders(llmConfig.providers);
      }
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
      const message = err instanceof Error ? err.message : String(err);
      dispatch({ type: "BOOT_ERROR", error: message });
      // Surface boot failure in addition to the in-page banner — the user
      // frequently sees a blank session shell otherwise.
      emitToast(
        "error",
        i18n.t("toast.bootFailed", { defaultValue: "Failed to initialise session" }) as string,
        message,
      );
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
      case "narrative.delta": {
        const delta = (payload.delta as string) ?? "";
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const pluginId = (payload.pluginId as string) ?? "";
        // Only show story-kind runtime text in main chat; plugin text goes to debug only
        const deltaKind = (payload.kind as string) ?? runtimeKindRef.current.get(runtimeId);
        if (delta && deltaKind === "story") {
          // Buffer deltas and flush once per animation frame to avoid per-token array copies.
          // Capture the current sessionId on each push so the RAF can drop stale entries
          // if the user switches sessions mid-stream — otherwise the pending flush would
          // dispatch APPEND_DELTA into the NEW session's messages array.
          const bufKey = `${turnId ?? "unknown"}_${runtimeId}`;
          const existing = deltaBufferRef.current.get(bufKey);
          if (existing) {
            existing.text += delta;
          } else {
            deltaBufferRef.current.set(bufKey, {
              turnId: turnId ?? "unknown",
              runtimeId,
              pluginId,
              text: delta,
              flushSessionId: sessionIdRef.current,
            });
          }
          if (deltaRafRef.current === null) {
            deltaRafRef.current = requestAnimationFrame(() => {
              const currentSid = sessionIdRef.current;
              for (const entry of deltaBufferRef.current.values()) {
                if (entry.flushSessionId !== currentSid) continue; // session changed — drop
                dispatch({ type: "APPEND_DELTA", turnId: entry.turnId, runtimeId: entry.runtimeId, pluginId: entry.pluginId, delta: entry.text });
              }
              deltaBufferRef.current.clear();
              deltaRafRef.current = null;
            });
          }
        }
        break;
      }
      case "narrative.completed": {
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
            }).catch(() => { });
          }
        }
        break;
      }
      // ── Interaction events ────────────────────────────────────
      case "interaction.requested": {
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
            }).catch(() => { });
          }
        }
        break;
      }
      // ── State events ─────────────────────────────────────────
      case "state.changed": {
        // Session Kernel sends: { table, field, value, runtimeId, pluginId }
        const table = payload.table as string | undefined;
        const field = payload.field as string | undefined;
        const value = payload.value;

        const patch = {
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
          }).catch(() => { });
        }
        break;
      }
      // phase.changed is delivered exclusively through the persistent
      // /events/stream subscription below — both channels share the same
      // eventBus, so handling it here too would dispatch twice per event.
      // ── Execution lifecycle events ───────────────────────────
      case "execution.started": {
        // Turn-level execution started — tracked by `executing` flag, no fake runtime step needed
        break;
      }
      case "runtime.started": {
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const pluginId = (payload.pluginId as string) ?? "";
        const label = payload.label as string | undefined;
        // Prefer payload.kind (new SSE contract); fall back to "pluginId/kind"
        // label for legacy servers.
        let kind = payload.kind as string | undefined;
        if (!kind && label) {
          const slashIdx = label.indexOf("/");
          if (slashIdx >= 0) kind = label.slice(slashIdx + 1);
        }
        if (kind) runtimeKindRef.current.set(runtimeId, kind);
        dispatch({
          type: "UPSERT_EXECUTION_STEP",
          step: {
            runtimeId,
            pluginId,
            status: "running",
            label,
            turnId,
            startedAt: envelope.timestamp,
          },
        });
        break;
      }
      case "runtime.completed": {
        dispatch({
          type: "UPSERT_EXECUTION_STEP",
          step: {
            runtimeId: (payload.runtimeId as string) ?? "unknown",
            pluginId: (payload.pluginId as string) ?? "",
            status: "completed",
            durationMs: payload.durationMs as number | undefined,
            turnId,
          },
        });
        break;
      }
      case "runtime.failed": {
        dispatch({
          type: "UPSERT_EXECUTION_STEP",
          step: {
            runtimeId: (payload.runtimeId as string) ?? "unknown",
            pluginId: (payload.pluginId as string) ?? "",
            status: "failed",
            detail: payload.error as string | undefined,
            durationMs: payload.durationMs as number | undefined,
            turnId,
          },
        });
        break;
      }
      case "runtime.skipped": {
        dispatch({
          type: "UPSERT_EXECUTION_STEP",
          step: {
            runtimeId: (payload.runtimeId as string) ?? "unknown",
            pluginId: (payload.pluginId as string) ?? "",
            status: "skipped",
            durationMs: payload.durationMs as number | undefined,
            turnId,
          },
        });
        break;
      }
      case "execution.completed": {
        dispatch({ type: "SET_EXECUTING", value: false });
        dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
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
      // plugin-data.changed is delivered exclusively through the persistent
      // /events/stream subscription below — both channels share the same
      // eventBus so handling it here too would dispatch twice per event.
      // ── Error events ──────────────────────────────────────────
      case "error.occurred": {
        dispatch({ type: "SET_EXECUTION_ERROR", error: (payload.message as string) ?? "Execution failed" });
        dispatch({ type: "SET_EXECUTING", value: false });
        dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
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
  const startGame = useCallback(async (plugins?: string[]) => {
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
      const session = await ds.createSession(state.world.id, presetId, undefined, plugins, i18n.language);
      dispatch({ type: "SET_SESSION", session });
      // Copy prep-phase runtime bindings to the real session and PATCH them
      // onto the server record. The per-runtime slot resolver reads
      // session.runtimeModelOverrides at turn time; without a PATCH, any
      // selection made on the prep screen has zero effect on the backend.
      const prepBindings = api.getPrepRuntimeBindings(state.world.id);
      if (Object.keys(prepBindings).length > 0) {
        const overrides: Record<string, string> = {};
        for (const [runtimeId, slot] of Object.entries(prepBindings)) {
          if (typeof slot === "string" && slot.length > 0)
            overrides[runtimeId] = slot;
        }
        try {
          await api.updateSession(session.id, { runtimeModelOverrides: overrides });
        } catch {
          // Non-fatal: overrides fall back to manifest defaults when missing
        }
        // Prep bindings are no longer needed — authoritative copy now lives
        // on the SessionRecord.
        api.clearPrepRuntimeBindings(state.world.id);
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
    const worldId = state.world?.id ?? "";

    const postStart = (loreOverride?: unknown) => {
      dispatch({ type: "SET_EXECUTING", value: true });
      const payload: Record<string, unknown> = loreOverride ? { loreOverride } : {};
      api.sendAction(
        { requestId: api.uid(), type: "start_session", sessionId, locale: i18n.language, payload },
        handleSseEvent,
        (err) => {
          // Session stays valid; user can press 开始冒险 again to retry, so
          // we only surface the error rather than tear anything down.
          dispatch({ type: "SET_EXECUTION_ERROR", error: err.message });
          dispatch({ type: "SET_EXECUTING", value: false });
          dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
        },
        () => {
          dispatch({ type: "SET_EXECUTING", value: false });
          dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
        },
      );
    };

    // Overlay is optional metadata (world lore override). Fetch failures
    // should never block the adventure from starting.
    void api.getWorldOverlay(worldId)
      .then((overlay) => postStart(overlay?.lore))
      .catch(() => postStart());
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
    // Rebind plugin-data-store synchronously so any plugin-data.changed
    // events that arrive before the sessionIdRef effect commits write to
    // the new session's slot. The effect will call this again with the
    // same sessionId (no-op) once React commits the SET_SESSION dispatch.
    setActivePluginDataSession(targetSessionId);

    // Server snapshot is the authoritative source of messages, gameState,
    // characters, characterSchema and execution trace. IDB (T1/T2 self-deploy)
    // is only used when the server doesn't expose a snapshot endpoint.
    // Mirrors V2's single-call resume path; replaces the old three-way IDB
    // fan-out that could race against server state and show stale data.
    let snapshotLoaded = false;
    try {
      const snapshot = await api.getSessionSnapshot(session.id);
      if (sessionIdRef.current !== targetSessionId) return;

      const streamMessages: StreamMessage[] = snapshot.messages.map((m) => ({
        id: m.id,
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
        timestamp: m.createdAt,
        turnId: m.turnId,
        runtimeId: m.runtimeId,
        kind: m.kind,
        ...(m.block ? { block: m.block as Record<string, unknown> } : {}),
      }));
      dispatch({ type: "LOAD_MESSAGES", messages: streamMessages });

      if (snapshot.characters.length > 0 || Object.keys(snapshot.gameState).length > 0 || snapshot.characterSchema) {
        const enrichedState: Record<string, unknown> = {
          ...snapshot.gameState,
          characters: snapshot.characters,
        };
        if (snapshot.characterSchema) {
          enrichedState.characterSchema = snapshot.characterSchema;
        }
        dispatch({ type: "SET_GAME_STATE", state: enrichedState });
      }

      if (snapshot.executionSteps.length > 0) {
        const byKey = new Map<string, ExecutionStep>();
        for (const evt of snapshot.executionSteps) {
          if (!evt.type.startsWith('runtime.')) continue;
          const p = evt.payload as Record<string, unknown>;
          const runtimeId = (p.runtimeId as string) ?? '';
          if (!runtimeId || runtimeId === '__turn__') continue;
          const key = `${evt.turnId ?? '__no_turn__'}|${runtimeId}`;
          const prev = byKey.get(key);
          const status: ExecutionStep["status"] =
            evt.type === 'runtime.completed' ? 'completed' :
              evt.type === 'runtime.failed' ? 'failed' :
                evt.type === 'runtime.skipped' ? 'skipped' :
                  'running';
          byKey.set(key, {
            runtimeId,
            pluginId: (p.pluginId as string) ?? prev?.pluginId ?? '',
            status,
            turnId: evt.turnId,
            label: (p.label as string | undefined) ?? prev?.label,
            durationMs: (p.durationMs as number | undefined) ?? prev?.durationMs,
            startedAt: evt.type === 'runtime.started' ? evt.timestamp : prev?.startedAt,
          });
        }
        dispatch({ type: "LOAD_EXECUTION_STEPS", steps: [...byKey.values()] });
      }

      snapshotLoaded = true;
    } catch {
      // Server unavailable or snapshot endpoint missing — fall back to IDB.
    }

    if (!snapshotLoaded) {
      // Fallback path for T1/T2 deployments (no server snapshot endpoint).
      const [messagesResult, patchesResult, stateSnapResult] = await Promise.allSettled([
        ds.listMessages(session.id),
        ds.listStatePatches(session.id),
        ds.loadStateSnapshot(session.id),
      ]);
      if (sessionIdRef.current !== targetSessionId) return;

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
      }
      if (patchesResult.status === "fulfilled") {
        dispatch({ type: "LOAD_STATE_PATCHES", patches: patchesResult.value });
      }
      if (stateSnapResult.status === "fulfilled" && stateSnapResult.value) {
        const snapshotState = stateSnapResult.value.state as Record<string, unknown> | undefined;
        if (snapshotState) {
          dispatch({ type: "SET_GAME_STATE", state: snapshotState });
        }
      }
    }

    // Discard if session changed during restore
    if (sessionIdRef.current !== targetSessionId) return;

    // Restore submitted block IDs (and any persisted form values) via DataService
    try {
      const { ids: blockIds, values: blockValues } = await ds.loadSubmittedBlocks(session.id);
      if (sessionIdRef.current !== targetSessionId) return;
      for (const blockId of blockIds) {
        dispatch({ type: "SUBMIT_BLOCK", blockId, values: blockValues[blockId] });
      }
    } catch { /* ignore load errors */ }

    // Restore accumulated execution steps from DataService (persisted across refreshes).
    // Legacy persisted shape used `type: "runtime.started"`; migrate on the fly
    // so old sessions still restore without leaving chips stuck mid-flow.
    try {
      const raw = (await ds.loadExecutionSteps(session.id)) as unknown[];
      if (sessionIdRef.current !== targetSessionId) return;
      const migrated = (raw as Array<Record<string, unknown>>).map((r): ExecutionStep => {
        const legacyType = r.type as string | undefined;
        const legacyStatus: ExecutionStep["status"] =
          legacyType === "runtime.completed" ? "completed" :
            legacyType === "runtime.failed" ? "failed" :
              legacyType === "runtime.skipped" ? "skipped" :
                (r.status as ExecutionStep["status"] | undefined) ?? "completed";
        return {
          runtimeId: (r.runtimeId as string) ?? "unknown",
          pluginId: (r.pluginId as string) ?? "",
          status: legacyStatus,
          label: r.label as string | undefined,
          detail: r.detail as string | undefined,
          durationMs: r.durationMs as number | undefined,
          turnId: r.turnId as string | undefined,
          startedAt: (r.startedAt as string | undefined) ?? (r.timestamp as string | undefined),
        };
      });
      for (const step of migrated) {
        dispatch({ type: "UPSERT_EXECUTION_STEP", step });
      }
    } catch { /* ignore load errors */ }

    // Load session-scoped plugins so right panel can discover world-data-provider.
    // loadSessionPlugins is defined later in the hook, so call the API directly here.
    api.listSessionPlugins(session.id).then((res) => {
      if (sessionIdRef.current === targetSessionId) {
        dispatch({ type: "LOAD_SESSION_PLUGINS", plugins: res.available });
      }
    }).catch(() => { });

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
        }).catch(() => { });
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

        api.ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
          .then(fireAction)
          .catch(fireAction);
      });
    },
    [state.session, handleSseEvent],
  );

  const sendMessage = useCallback((content: string) => {
    if (!state.session || state.executing) return;

    dispatch({ type: "SET_EXECUTING", value: true });
    dispatch({ type: "SET_EXECUTION_ERROR", error: null });

    runSingleAction(content, { echoUserMessage: true }).finally(() => {
      dispatch({ type: "SET_EXECUTING", value: false });
      dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
    });
  }, [state.session, state.executing, runSingleAction]);

  const submitBlock = useCallback((blockId: string, values?: Record<string, unknown>) => {
    dispatch({ type: "SUBMIT_BLOCK", blockId, values });
    // Persist via DataService so submitted state (and form values) survives refresh
    const sid = sessionIdRef.current;
    if (!sid) return;
    ds.loadSubmittedBlocks(sid).then(({ ids, values: existingValues }) => {
      const nextIds = ids.includes(blockId) ? ids : [...ids, blockId];
      const nextValues = values
        ? { ...existingValues, [blockId]: values }
        : existingValues;
      ds.saveSubmittedBlocks(sid, nextIds, nextValues).catch(() => { });
    }).catch(() => { });
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
      const filled = result.results?.[0]?.filledNarrative ?? '';
      const firstContent = echo ? filled : '';

      dispatch({ type: "SET_EXECUTING", value: true });
      dispatch({ type: "SET_EXECUTION_ERROR", error: null });

      try {
        await runSingleAction(firstContent, { echoUserMessage: echo && Boolean(filled) });
      } finally {
        dispatch({ type: "SET_EXECUTING", value: false });
        dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
      }
    } catch (err) {
      console.error('[submitInteraction] Failed:', err);
      // Still send raw values as fallback
      const rawContent = Object.values(values).join(', ');
      sendMessage(rawContent);
    }
  }, [submitBlock, sendMessage, runSingleAction]);

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
          dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
        },
        () => {
          dispatch({ type: "SET_EXECUTING", value: false });
          dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
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
          dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
        },
        () => {
          dispatch({ type: "SET_EXECUTING", value: false });
          dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
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
    ds.saveExecutionSteps(sid, state.executionSteps).catch(() => { });
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
    api.fetchUiSpecs(sid)
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
          api.listPluginData(sid, pid, "message")
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
            .catch(() => { });
        }
      })
      .catch(() => {
        if (cancelled) return;
        dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs: [] });
      });
    return () => { cancelled = true; };
  }, [state.session?.id]);

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

    // plugin-data.changed arrives on topic="plugin" with _subType="plugin-data.changed"
    // (see apps/server/src/routes/api/bootstrap.ts:emitPluginDataChangedEvent).
    // Do NOT add "plugin-data" as a topic — the server whitelist rejects it (400).
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
              .catch(() => { });
          }
          break;
        }
        case "world.dimensions.changed": {
          // Refresh world data from server so UI can prompt sync
          const worldId = event.payload?.worldId as string | undefined;
          if (worldId) {
            api.getWorld(worldId)
              .then((world) => dispatch({ type: "UPDATE_WORLD", world }))
              .catch(() => { });
          }
          break;
        }
        case "plugin-data.changed": {
          // Sync out-of-band plugin data changes to both stores
          const pluginId = event.payload?.pluginId as string;
          const changes = event.payload?.changes as readonly PluginDataChange[];
          if (pluginId && changes) {
            dispatch({ type: "PLUGIN_DATA_CHANGED", pluginId, changes });
            applyPluginDataStoreChanges(pluginId, changes);
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
          dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
        },
        () => {
          dispatch({ type: "SET_EXECUTING", value: false });
          dispatch({ type: "FINALIZE_HANGING_RUNTIMES", reason: "__i18n:session.reasonConnectionClosed__" });
        },
      );
    };

    api.ensureServerSession(sessionId, (sid) => ds.syncToServer(sid))
      .then(fireAction)
      .catch(fireAction);
  }, [state.session, state.executing, handleSseEvent]);

  const upsertInteractionDraft = useCallback((draft: PendingInteractionDraft) => {
    dispatch({ type: "UPSERT_DRAFT", draft });
  }, []);

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
    upsertInteractionDraft,
    removeInteractionDraft,
    clearInteractionDrafts,
    setComposerText,
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
