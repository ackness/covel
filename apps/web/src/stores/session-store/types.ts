import type { AssetGenerateView, SnapshotCharacter } from "@covel/shared";
import type * as api from "@/services/api";

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
 * The current store uses a status-aggregation model: each runtime has a single row, and
 * every SSE event upserts the status in-place. A missed event still leaves
 * the row in the best known state, and the next arriving event overwrites
 * cleanly. That is what we adopt here to keep chips from getting stuck.
 */
export interface ExecutionStep {
  runtimeId: string;
  pluginId: string;
  status:
    | "running"
    | "llm"
    | "tool"
    | "completed"
    | "failed"
    | "skipped"
    | "suspended";
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

/**
 * Suspended runtime awaiting external input (F4 — suspend/resume web integration).
 *
 * The backend persists a fuller record in the store (pendingContinuation etc.);
 * only the UI-visible fields travel through api.ts via `listSuspensions` and
 * the SSE payloads; we re-export that shape from session-store.tsx so callers
 * can keep using `import type { SuspensionRecord } from "@/stores/session-store"`.
 */
export type SuspensionRecord = api.SuspensionRecord;

export interface PendingInteractionDraft {
  id: string;
  turnId: string;
  interactionId: string;
  type: "form" | "choice" | "confirmation" | "suggestion";
  label: string;
  values: Record<string, unknown>;
  /**
   * StreamMessage id of the block that produced this draft. When the player
   * confirms drafts, the framework stamps the block as submitted and records
   * the player's chosen labels — so re-rendering the disabled block can show
   * the historical selection. Optional for backward compatibility with drafts
   * that originate outside a block (e.g. composer-only).
   */
  sourceBlockId?: string;
  selectionGroup?: string;
  submitBehavior?: { echoFilledNarrative?: boolean };
}

export interface AssetProgressEvent {
  assetId?: string;
  phase: string;
  percent?: number;
  message?: string;
  modality?: string;
  pluginId?: string;
  runtimeId?: string;
  meta?: Record<string, unknown>;
  timestamp: string;
}

export interface SessionState {
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
  messages: StreamMessage[];

  /** All sessions for the current world (for switching). */
  worldSessions: api.SessionRecord[];

  // Execution
  executing: boolean;
  executionError: string | null;
  /** Real-time execution progress steps from kernel. */
  executionSteps: ExecutionStep[];

  /**
   * Active suspensions awaiting external resume (F4).
   *
   * Populated from `GET /api/sessions/:id/suspensions` on session restore and
   * maintained live via `turn.suspended` / `turn.resumed` SSE events. Cleared
   * when the matching resume/cancel call succeeds.
   */
  suspensions: SuspensionRecord[];

  // State patches from kernel
  statePatches: Array<{
    id: string;
    summary: string;
    packageName: string;
    data?: unknown;
  }>;

  /** Accumulated game state from state.patch events. */
  gameState: Record<string, unknown>;

  /** Plugin data keyed by pluginId -> namespace -> key -> value. Updated via plugin-data.changed events. */
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

  /**
   * Assets emitted via `asset.generated` SSE keyed by turnId. Populated by the
   * kernel's commit handler (see `session-kernel.ts` — emits one envelope per
   * `asset.generate` proposal); rendered out-of-band by `<AssetTurnSidebar>`
   * so the existing message timeline stays untouched. Order within a turn
   * matches arrival order. Cleared on session swap / reset.
   */
  readonly assetsByTurn: ReadonlyMap<string, readonly AssetGenerateView[]>;

  /** Progress events emitted before the final asset.generate commit. */
  readonly assetProgressByTurn: ReadonlyMap<
    string,
    readonly AssetProgressEvent[]
  >;

  /** Block IDs that have been submitted by the player (permanently locked). */
  submittedBlockIds: ReadonlySet<string>;

  /**
   * Form values keyed by submitted block id. Used to repopulate disabled
   * forms so the player can still see what they originally entered.
   */
  submittedBlockValues: Readonly<Record<string, Record<string, unknown>>>;
}

export type SessionAction =
  | {
      type: "BOOT_SUCCESS";
      presets: api.PresetSummary[];
      packages: api.PackageSummary[];
      pluginLoadErrors: api.PluginLoadError[];
      commands: api.CommandSummary[];
      worlds: api.WorldRecord[];
      llmConfig: api.LlmConfigResponse | null;
    }
  | { type: "BOOT_ERROR"; error: string }
  | { type: "SET_WORLD"; world: api.WorldRecord }
  | { type: "ADD_WORLD"; world: api.WorldRecord }
  | { type: "UPDATE_WORLD"; world: api.WorldRecord }
  | { type: "REMOVE_WORLD"; worldId: string }
  | { type: "SET_SESSION"; session: api.SessionRecord }
  | { type: "SET_WORLD_SESSIONS"; sessions: api.SessionRecord[] }
  | { type: "ADD_MESSAGE"; message: StreamMessage }
  | {
      type: "COMPLETE_MESSAGE";
      turnId: string;
      runtimeId: string;
      message: StreamMessage;
    }
  | {
      type: "APPEND_DELTA";
      turnId: string;
      runtimeId: string;
      pluginId: string;
      delta: string;
    }
  | { type: "SET_EXECUTING"; value: boolean }
  | { type: "SET_EXECUTION_ERROR"; error: string | null }
  | {
      type: "ADD_STATE_PATCH";
      patch: {
        id: string;
        summary: string;
        packageName: string;
        data?: unknown;
      };
    }
  | { type: "LOAD_MESSAGES"; messages: StreamMessage[] }
  | {
      type: "LOAD_STATE_PATCHES";
      patches: Array<{
        id: string;
        summary: string;
        packageName: string;
        data?: unknown;
      }>;
    }
  | { type: "UPSERT_EXECUTION_STEP"; step: ExecutionStep }
  | { type: "LOAD_EXECUTION_STEPS"; steps: ExecutionStep[] }
  | { type: "CLEAR_EXECUTION_STEPS" }
  | { type: "FINALIZE_HANGING_RUNTIMES"; reason: string }
  | { type: "RESET_SESSION" }
  | { type: "SUBMIT_BLOCK"; blockId: string; values?: Record<string, unknown> }
  | { type: "RESET_TO_WORLD_SELECT" }
  | {
      type: "REMOVE_MESSAGES_FROM_TURN";
      turnId: string;
      keepRuntimeIds: ReadonlySet<string>;
    }
  | { type: "SET_GAME_STATE"; state: Record<string, unknown> }
  | { type: "REMOVE_SESSION"; sessionId: string }
  | { type: "LOAD_SESSION_PLUGINS"; plugins: api.SessionPluginInfo[] }
  | { type: "TOGGLE_SESSION_PLUGIN"; pluginId: string; isActive: boolean }
  | { type: "BACKFILL_TURN_ID"; turnId: string }
  | {
      type: "PLUGIN_DATA_CHANGED";
      pluginId: string;
      changes: readonly {
        namespace: string;
        key: string;
        value: unknown;
        operation: string;
      }[];
    }
  | { type: "LOAD_MESSAGE_UI_SPECS"; specs: api.UISlotEntry[] }
  | { type: "UPSERT_PLUGIN_MESSAGE_SURFACE"; pluginId: string }
  | { type: "UPSERT_DRAFT"; draft: PendingInteractionDraft }
  | { type: "REMOVE_DRAFT"; draftId: string }
  | { type: "CLEAR_DRAFTS" }
  | { type: "SET_SUSPENSIONS"; suspensions: SuspensionRecord[] }
  | { type: "ADD_SUSPENSION"; suspension: SuspensionRecord }
  | { type: "REMOVE_SUSPENSION"; suspensionId: string }
  | { type: "ASSET_GENERATED"; turnId: string; asset: AssetGenerateView }
  | { type: "ASSET_PROGRESS"; turnId: string; progress: AssetProgressEvent };

export type SessionDispatch = (action: SessionAction) => void;

export type { SnapshotCharacter };
