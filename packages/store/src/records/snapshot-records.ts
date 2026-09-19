/**
 * Snapshot and suspension record types.
 *
 * Re-exported through the store's public types entry point.
 */

import type {
  CharacterRecord,
  StateEntryRecord,
  StateSchemaRecord,
} from "./state-records.js";
import type {
  LorebookEntryRecord,
  SessionSummaryRecord,
  WorkingMemoryRecord,
} from "./memory-records.js";
import type { PluginDataRecord } from "./plugin-records.js";
import type { SessionRecord } from "./session-records.js";
import type {
  ExecutionContext,
  InputSlot,
  RuntimeExportRecord,
} from "@covel/shared";

/**
 * Materialized state snapshot.
 *
 * Each record captures the full session state at the end of a given turn as a
 * serialized payload. Snapshots power save / load / fork — every new session
 * created via `POST /fork` is rebuilt from a snapshot payload.
 *
 * `kind`:
 *  - `auto`   — created at turn commit.
 *  - `manual` — created explicitly via `POST /api/sessions/:id/snapshots`.
 *  - `fork`   — created when a fork rebuilds a new session; `parentId`
 *               points at the origin snapshot.
 *
 * `payload.schemaVersion` identifies the current payload contract. Earlier
 * formats are unsupported; affected development snapshots must be recreated.
 */
export type SnapshotKind = "auto" | "manual" | "fork";

export interface SnapshotPayload {
  readonly schemaVersion: 3;
  readonly session: SnapshotSessionState;
  readonly turnId: string;
  readonly characters: readonly CharacterRecord[];
  readonly stateEntries: readonly StateEntryRecord[];
  /** Frozen table definitions. Empty means no captured tables. */
  readonly stateSchemas: readonly StateSchemaRecord[];
  /** Latest visible revision of every export series at capture time. */
  readonly runtimeExports: readonly RuntimeExportRecord[];
  readonly pluginData: readonly PluginDataRecord[];
  readonly workingMemory: readonly WorkingMemoryRecord[];
  /**
   * Compaction summaries referenced by messages at or before
   * {@link messagesCursor}.
   */
  readonly sessionSummaries: readonly SessionSummaryRecord[];
  /**
   * Snapshot-time mapping from parent `turn_message.id` to the summary id that
   * represented it. Message compaction tags are mutable because rolling
   * summaries retag the historical prefix; retaining this exact mapping keeps
   * a later fork pinned to the snapshot instant.
   */
  readonly compactedMessageSummaryIds: Readonly<Record<string, string>>;
  /**
   * Session-scoped lorebook entries. Captured from the
   * `lorebook_entries` table at snapshot time so forks can rehydrate the
   * session-layer lorebook without re-running world-init plugins.
   */
  readonly lorebookEntries: readonly LorebookEntryRecord[];
  /**
   * Unresolved suspensions at snapshot time (audit 2026-04-20 finding 7.3).
   *
   * Only suspensions whose `resolvedAt` is unset are captured — resolved or
   * claimed-but-still-executing records are excluded because the target
   * runtime is either done or in-flight and the child session has no way to
   * take over mid-flight. Each suspension travels with its full
   * `pendingContinuation` so the forked session can POST
   * /suspensions/:suspensionId/resume using the copied id.
   *
   * The fork route regenerates each suspension's id and rebinds
   * `sessionId = childSessionId` before persisting, so the original parent
   * record is preserved.
   */
  readonly suspensions: readonly SuspensionRecord[];
  /**
   * Last `turn_messages.id` persisted for this session at snapshot time.
   * Used by fork to bound how many messages are copied.
   * Empty string when there are no messages yet.
   */
  readonly messagesCursor: string;
  /**
   * Chat history boundary, independent of the model conversation cursor.
   * Capture every id in the newest millisecond so later same-time messages
   * cannot enter an older fork. Null means empty.
   */
  readonly displayMessagesBoundary: {
    readonly createdAt: string;
    readonly ids: readonly string[];
  } | null;
}

/**
 * Session-level state that must be restored from the same point in time as
 * the materialized rows above. Authority and maintenance fields (for example
 * owner tokens and embedding locks) remain session-local.
 */
export type SnapshotSessionState = Readonly<
  Pick<
    SessionRecord,
    | "status"
    | "phase"
    | "completedPlayerTurns"
    | "setupRuntimes"
    | "locale"
    | "activePlugins"
    | "runtimeModelOverrides"
  > & {
    /** Captured metadata override. Empty means clear; absent keeps world fallback. */
    loreOverride?: string;
  }
>;

export interface SnapshotRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly kind: SnapshotKind;
  readonly parentId?: string;
  readonly payload: SnapshotPayload;
  readonly createdAt: string;
}

/**
 * Snapshot metadata WITHOUT the payload — the projection returned by
 * {@link SnapshotStore.listSnapshotsPage}. A snapshot payload serializes the
 * whole session state, so the list surface (save/load UI) must never load them
 * all just to render a row per save. `size` is the payload's serialized length
 * (characters), computed at the DB layer so the payload column is never
 * transferred or deserialized during a list.
 */
export interface SnapshotMetadata {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly kind: SnapshotKind;
  readonly parentId?: string;
  readonly createdAt: string;
  readonly size: number;
}

// ── Suspensions ──────────────────────────────────────────

/**
 * Persisted state for a suspended runtime (suspend/resume primitive).
 *
 * When an agent runtime calls the `suspend` builtin tool, the turn-executor
 * captures the current LLM message array and tool-call history, writes a
 * SuspensionRecord, and returns `status: 'suspended'`.
 *
 * On `POST /api/sessions/:id/suspensions/:suspensionId/resume { data }`, the resume
 * handler loads this record, reconstructs the message array, appends a
 * synthetic message carrying `data`, and re-enters the LLM tool loop.
 *
 * NOTE: Provider API keys are NEVER stored here — they must be supplied
 * again via the `X-Provider-Keys` header on the resume request.
 */
export interface SuspensionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly reason: string;
  /** Plain JSON schema object { type, properties, required }. Not a live Zod schema. */
  readonly resumeSchema: unknown;
  readonly pendingContinuation: {
    /** Full LLMMessage[] up to the suspend point. */
    readonly messages: readonly unknown[];
    /** If the LLM produced narrative text alongside the suspend tool call. */
    readonly partialContent?: string;
    /** ToolCallRecord[] accumulated before the suspend point. */
    readonly toolCallsSoFar: readonly unknown[];
    /** Execution evidence for completion checks after an agent resumes. */
    readonly completionCalls?: readonly {
      readonly name: string;
      readonly success: boolean;
      readonly done: boolean;
    }[];
    /**
     * Proposals buffered mid-turn at the suspend point.
     *
     * Agent tools can queue proposal-backed writes before the runtime
     * decides to suspend. Resume re-hydrates this array so the buffered
     * proposals survive the suspend boundary and commit together with the
     * final runtime output.
     */
    readonly pendingProposals: readonly unknown[];
    /** Frozen declared inputs for tools resumed in the same logical turn. */
    readonly inputSlots?: Readonly<Record<string, InputSlot>>;
    /**
     * Framework-owned execution identity from the suspended scheduling run.
     * Resume inherits its logical turn and count policy while allocating a new
     * execution id, so suspension itself never completes a player turn.
     */
    readonly executionContext: ExecutionContext;
    /** Events buffered before suspension; resume must not silently drop them. */
    readonly emittedEvents?: readonly unknown[];
    /** tool_call_id of the suspend tool call (agent runtime only). Used to append synthetic tool result. */
    readonly suspendToolCallId?: string;
  };
  readonly createdAt: string;
  /** Set to ISO timestamp when resume completes successfully. */
  readonly resolvedAt?: string;
}
