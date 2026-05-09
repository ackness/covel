import type { AssetGenerateView } from "@covel/shared";
import { deepMerge } from "@covel/shared";
import {
  mergeGameStateForReplacement,
  rebuildGameStateFromPatches,
} from "./game-state.js";
import { applyPluginMessageSurface } from "./plugin-message-surface.js";
import type {
  AssetProgressEvent,
  LegacyPhase,
  SessionAction,
  SessionState,
} from "./types.js";
import type * as api from "@/services/api";

const EXEC_STEPS_MAX = 500;

export function toLegacyPhase(
  session: Pick<api.SessionRecord, "status" | "turnCount"> | null | undefined,
): LegacyPhase {
  if (!session) return "init";
  if (session.status === "ended") return "ended";
  if (session.status === "paused") return "paused";
  return (session.turnCount ?? 0) >= 1 ? "playing" : "init";
}

export const initialState: SessionState = {
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
  suspensions: [],
  assetsByTurn: new Map<string, readonly AssetGenerateView[]>(),
  assetProgressByTurn: new Map<string, readonly AssetProgressEvent[]>(),
};

export function reducer(
  state: SessionState,
  action: SessionAction,
): SessionState {
  switch (action.type) {
    case "BOOT_SUCCESS":
      return {
        ...state,
        booted: true,
        bootError: null,
        presets: action.presets,
        packages: action.packages,
        pluginLoadErrors: action.pluginLoadErrors,
        commands: action.commands,
        worlds: action.worlds,
        llmConfig: action.llmConfig,
      };
    case "BOOT_ERROR":
      return { ...state, bootError: action.error };
    case "SET_WORLD":
      return { ...state, world: action.world };
    case "ADD_WORLD":
      return { ...state, worlds: [...state.worlds, action.world] };
    case "REMOVE_WORLD":
      return {
        ...state,
        worlds: state.worlds.filter((w) => w.id !== action.worldId),
      };
    case "UPDATE_WORLD":
      return {
        ...state,
        worlds: state.worlds.map((w) =>
          w.id === action.world.id ? action.world : w,
        ),
        world: state.world?.id === action.world.id ? action.world : state.world,
      };
    case "SET_SESSION": {
      // Reset asset map whenever the session id changes so assets from a
      // previous session never bleed into the new one. Other per-session
      // slices (messages, executionSteps, …) ride on RESET_SESSION earlier
      // in the dispatch chain — assetsByTurn defends here too because the
      // view layer reads it eagerly on render.
      const sameSession = state.session?.id === action.session.id;
      return {
        ...state,
        session: action.session,
        phase: toLegacyPhase(action.session),
        assetsByTurn: sameSession
          ? state.assetsByTurn
          : new Map<string, readonly AssetGenerateView[]>(),
        assetProgressByTurn: sameSession
          ? state.assetProgressByTurn
          : new Map<string, readonly AssetProgressEvent[]>(),
      };
    }
    case "SET_WORLD_SESSIONS":
      return { ...state, worldSessions: action.sessions };
    case "REMOVE_SESSION":
      return {
        ...state,
        worldSessions: state.worldSessions.filter(
          (s) => s.id !== action.sessionId,
        ),
      };
    case "ADD_MESSAGE": {
      const existingIdx = state.messages.findIndex(
        (m) => m.id === action.message.id,
      );
      if (existingIdx >= 0) {
        const next = [...state.messages];
        next[existingIdx] = { ...next[existingIdx], ...action.message };
        return { ...state, messages: next };
      }
      return { ...state, messages: [...state.messages, action.message] };
    }
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
        next[idx] = {
          ...action.message,
          id: state.messages[idx].id,
          kind: "story",
        };
        return { ...state, messages: next };
      }
      return {
        ...state,
        messages: [...state.messages, { ...action.message, kind: "story" }],
      };
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
        const newMessages = state.messages.with(idx, {
          ...prev,
          content: prev.content + action.delta,
        });
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
      const patchData = action.patch.data as
        | Record<string, unknown>
        | undefined;
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
      // guide) never show up on page refresh after hydration+snapshot
      // race to completion in the unfavourable order.
      let nextState: SessionState = { ...state, messages: action.messages };
      for (const entry of nextState.messageUiSpecs) {
        if (nextState.pluginData[entry.pluginId]?.message) {
          nextState = applyPluginMessageSurface(nextState, entry.pluginId);
        }
      }
      return nextState;
    }
    case "LOAD_STATE_PATCHES":
      return {
        ...state,
        statePatches: action.patches,
        gameState: rebuildGameStateFromPatches(action.patches),
      };
    case "SET_PHASE":
      return { ...state, phase: action.phase };
    case "SET_GAME_STATE":
      return {
        ...state,
        gameState: mergeGameStateForReplacement(state.gameState, action.state),
      };
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
      const capped =
        next.length > EXEC_STEPS_MAX
          ? next.slice(next.length - EXEC_STEPS_MAX)
          : next;
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
        (s) =>
          s.status === "running" || s.status === "llm" || s.status === "tool",
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
    case "SET_SUSPENSIONS":
      return { ...state, suspensions: action.suspensions };
    case "ADD_SUSPENSION": {
      // Dedupe by id: the same event can arrive on both the /actions SSE
      // forward and the persistent /events/stream subscription (they share
      // the EventBus). Idempotent add keeps the panel state correct.
      if (state.suspensions.some((s) => s.id === action.suspension.id)) {
        return state;
      }
      return {
        ...state,
        suspensions: [...state.suspensions, action.suspension],
      };
    }
    case "REMOVE_SUSPENSION":
      return {
        ...state,
        suspensions: state.suspensions.filter(
          (s) => s.id !== action.suspensionId,
        ),
      };
    case "SUBMIT_BLOCK":
      return {
        ...state,
        submittedBlockIds: new Set([
          ...state.submittedBlockIds,
          action.blockId,
        ]),
        submittedBlockValues: action.values
          ? { ...state.submittedBlockValues, [action.blockId]: action.values }
          : state.submittedBlockValues,
      };
    case "RESET_SESSION":
      return {
        ...state,
        session: null,
        phase: "init",
        messages: [],
        statePatches: [],
        gameState: {},
        pluginData: {},
        executing: false,
        executionError: null,
        executionSteps: [],
        submittedBlockIds: new Set<string>(),
        submittedBlockValues: {},
        sessionPlugins: [],
        messageUiSpecs: [],
        pendingInteractionDrafts: [],
        suspensions: [],
        assetsByTurn: new Map<string, readonly AssetGenerateView[]>(),
        assetProgressByTurn: new Map<string, readonly AssetProgressEvent[]>(),
      };
    case "RESET_TO_WORLD_SELECT":
      return {
        ...state,
        world: null,
        session: null,
        phase: "init",
        messages: [],
        worldSessions: [],
        statePatches: [],
        gameState: {},
        pluginData: {},
        executing: false,
        executionError: null,
        executionSteps: [],
        submittedBlockIds: new Set<string>(),
        submittedBlockValues: {},
        sessionPlugins: [],
        messageUiSpecs: [],
        pendingInteractionDrafts: [],
        suspensions: [],
        assetsByTurn: new Map<string, readonly AssetGenerateView[]>(),
        assetProgressByTurn: new Map<string, readonly AssetProgressEvent[]>(),
      };
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
        if (change.operation === "delete") {
          delete ns[change.key];
        } else {
          ns[change.key] = change.value;
        }
        pluginNs[change.namespace] = ns;
      }
      const nextState = {
        ...state,
        pluginData: { ...prev, [pluginId]: pluginNs },
      };
      // If any change touched namespace="message", refresh the synthesized
      // plugin_message surface for this plugin so chat can render it via json-render.
      if (changes.some((c) => c.namespace === "message")) {
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
      const filtered = state.pendingInteractionDrafts.filter(
        (d) =>
          d.id !== draft.id &&
          !(
            draft.selectionGroup &&
            d.turnId === draft.turnId &&
            d.selectionGroup === draft.selectionGroup
          ),
      );
      return { ...state, pendingInteractionDrafts: [...filtered, draft] };
    }
    case "REMOVE_DRAFT":
      return {
        ...state,
        pendingInteractionDrafts: state.pendingInteractionDrafts.filter(
          (d) => d.id !== action.draftId,
        ),
      };
    case "CLEAR_DRAFTS":
      return { ...state, pendingInteractionDrafts: [] };
    case "ASSET_GENERATED": {
      // Append the asset to its turn's bucket. We construct a new Map and a
      // new readonly array on every dispatch so memoised consumers (the
      // sidebar reads via state.assetsByTurn.get(turnId)) re-render on each
      // arrival. Same-id de-dup defends against the eventBus double-delivery
      // pattern documented in handleSseEvent (turn.suspended arrives twice
      // because /actions and /events/stream share the bus).
      const existing = state.assetsByTurn.get(action.turnId) ?? [];
      if (existing.some((a) => a.id === action.asset.id)) {
        return state;
      }
      const nextBucket: readonly AssetGenerateView[] = [
        ...existing,
        action.asset,
      ];
      const nextMap = new Map(state.assetsByTurn);
      nextMap.set(action.turnId, nextBucket);
      return { ...state, assetsByTurn: nextMap };
    }
    case "ASSET_PROGRESS": {
      const existing = state.assetProgressByTurn.get(action.turnId) ?? [];
      const nextMap = new Map(state.assetProgressByTurn);
      nextMap.set(action.turnId, [...existing, action.progress]);
      return { ...state, assetProgressByTurn: nextMap };
    }
    default:
      return state;
  }
}
