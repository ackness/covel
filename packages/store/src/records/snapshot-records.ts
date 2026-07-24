/**
 * Snapshot and suspension record types.
 *
 * Split out of `../types.ts` by domain; re-exported there for compatibility.
 */

import type { CharacterRecord, StateEntryRecord } from "./state-records.js";
import type {
  LorebookEntryRecord,
  WorkingMemoryRecord,
} from "./memory-records.js";
import type { PluginDataRecord } from "./plugin-records.js";
import type { SessionRecord } from "./session-records.js";

/**
 * Materialized state snapshot.
 *
 * Each record captures the full session state at the end of a given turn as a
 * serialized payload. Snapshots power save / load / fork — every new session
 * created via `POST /fork` is rebuilt from a snapshot payload.
 *
 * `kind`:
 *  - `auto`   — created at turn commit.
 *  - `manual` — created explicitly via `POST /api/sessions/:id/snapshot`.
 *  - `fork`   — created when a fork rebuilds a new session; `parentId`
 *               points at the origin snapshot.
 *
 * `payload.schemaVersion` allows future migrations without requiring a DB
 * schema change — the envelope stays stable while the payload can evolve.
 */
export type SnapshotKind = "auto" | "manual" | "fork";

interface SnapshotPayloadBase {
  readonly turnId: string;
  readonly characters: readonly CharacterRecord[];
  readonly stateEntries: readonly StateEntryRecord[];
  readonly pluginData: readonly PluginDataRecord[];
  readonly workingMemory: readonly WorkingMemoryRecord[];
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
   * `pendingContinuation` so the forked session can POST /resume using the
   * copied id.
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
}

/** Legacy payloads created before session lifecycle state was captured. */
export interface SnapshotPayloadV1 extends SnapshotPayloadBase {
  readonly schemaVersion: 1;
}

/**
 * Session-level state that must be restored from the same point in time as
 * the materialized rows above. Fields unrelated to scheduling or runtime
 * selection (for example embedding maintenance locks) remain session-local.
 */
export type SnapshotSessionState = Readonly<
  Pick<
    SessionRecord,
    | "status"
    | "turnCount"
    | "preGameCompleted"
    | "locale"
    | "activePlugins"
    | "presetId"
    | "runtimeModelOverrides"
  >
>;

/** V2 snapshot payload, including lifecycle and runtime configuration. */
export interface SnapshotPayloadV2 extends SnapshotPayloadBase {
  readonly schemaVersion: 2;
  readonly session: SnapshotSessionState;
}

/**
 * V3 session projection — the V2 fields plus the scheduling-redesign lifecycle
 * fields (`phase` / `completedPlayerTurns` / `setupRuntimes`). Restored from the
 * same point in time as the materialized rows so a fork resumes in the correct
 * band with its setup-runtime state intact. All three are optional (a snapshot
 * taken before the kernel populates them simply omits them).
 */
export type SnapshotSessionStateV3 = SnapshotSessionState &
  Readonly<
    Pick<SessionRecord, "phase" | "completedPlayerTurns" | "setupRuntimes">
  >;

/** Current snapshot payload — V2 lifecycle state plus setup-band state. */
export interface SnapshotPayloadV3 extends SnapshotPayloadBase {
  readonly schemaVersion: 3;
  readonly session: SnapshotSessionStateV3;
}

/**
 * Persisted snapshots are a versioned union. V1 remains readable for listing
 * and inspection; safe fork requires V2 lifecycle state; V3 additionally
 * carries setup-band state. Upgrade-on-read (V1/V2 → V3) is the kernel wave's
 * concern — the store round-trips whichever version it is handed verbatim.
 */
export type SnapshotPayload =
  SnapshotPayloadV1 | SnapshotPayloadV2 | SnapshotPayloadV3;

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
 * On `POST /api/sessions/:id/resume { suspensionId, data }`, the resume
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
    /**
     * Proposals buffered mid-turn at the suspend point.
     *
     * Agent tools can queue proposal-backed writes before the runtime
     * decides to suspend. Resume re-hydrates this array so the buffered
     * proposals survive the suspend boundary and commit together with the
     * final runtime output.
     */
    readonly pendingProposals: readonly unknown[];
    /** tool_call_id of the suspend tool call (agent runtime only). Used to append synthetic tool result. */
    readonly suspendToolCallId?: string;
  };
  readonly createdAt: string;
  /** Set to ISO timestamp when resume completes successfully. */
  readonly resolvedAt?: string;
}
