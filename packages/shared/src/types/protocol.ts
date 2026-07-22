/**
 * Covel Session Protocol — server→client event vocabulary + session snapshot.
 *
 * `CovelEvent` is the authoritative discriminated union for every server→client
 * event on the SSE streams; `SessionSnapshot` is the restore/reconnection shape.
 *
 * Transport is concrete, not abstract. Events ride two SSE streams (the per-turn
 * `POST /api/actions` action stream parsed via fetch + ReadableStream, and the
 * out-of-band `GET /api/events/stream` subscription channel via EventSource);
 * client→server requests go through the REST API (see docs/reference/api.md).
 * There is no transport-agnostic command layer — an earlier `SessionTransport`
 * command/capability abstraction was never implemented and has been removed.
 */

import type { JobStatusRecord } from "./runtime-lifecycle.js";

// ── Covel Event Union (server → client) — single source of truth ─
//
// `CovelEvent` is the ONE authoritative discriminated union for every
// server→client event that can appear on the per-turn action SSE stream
// (`POST /api/actions`). It is the single source for:
//   • the event-name vocabulary (`CovelEvent["type"]` → `CovelEventType`),
//   • the out-of-band forwarding whitelist (`FORWARDED_EVENT_TYPES`, derived
//     from `COVEL_EVENT_META` — never hand-maintained), and
//   • frontend exhaustiveness in the web SSE handler.
//
// Adding a new event = add one union member + one `COVEL_EVENT_META` entry.
// Forgetting either fails compilation (the `satisfies` clause below) and the
// frontend `assertNever` guard. Event names are MANDATORY (closed union);
// payloads are strongly typed where the shape is known and `CovelEventPayload`
// (open record) for runtime-internal / not-yet-pinned events. Tighten an open
// payload later by replacing `CovelEventPayload` with a precise interface — no
// untyped `payload[key]` reads are coupled to these shapes today.

/** Open payload for runtime-internal / trace events whose shape is not yet
 *  pinned. Structurally a read-only record so it stays compatible with the
 *  loose `SseEnvelope.payload` carried over the wire. */
export type CovelEventPayload = Readonly<Record<string, unknown>>;

export interface NarrativeDeltaPayload {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly kind?: string;
  readonly delta: string;
}

export interface NarrativeCompletedPayload {
  readonly runtimeId: string;
  readonly content: string;
  readonly messageId?: string;
  readonly kind?: string;
}

export interface InteractionRequestedPayload {
  readonly block?: Readonly<Record<string, unknown>>;
  readonly proposalId?: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly turnId?: string;
}

export interface UiRenderedPayload {
  readonly block?: Readonly<Record<string, unknown>>;
  readonly render?: Readonly<Record<string, unknown>>;
  readonly proposalId?: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly turnId?: string;
}

export interface StateChangedPayload {
  readonly table?: string;
  readonly field?: string;
  readonly value?: unknown;
  readonly pluginId?: string;
}

export interface ExecutionStartedPayload {
  readonly status: string;
  readonly runtimeCount: number;
}

/**
 * `ExecutionCompletedPayload.abortReason` value for a player-initiated abort
 * (Stop button / POST /abort). Wire-protocol constant: the runtime stamps it
 * on `TurnResult.abortReason` and the web client keys its non-error abort
 * terminal state on it (discard the uncommitted streaming placeholder instead
 * of showing a retryable error).
 */
export const PLAYER_ABORT_REASON = "aborted-by-player";

export interface ExecutionCompletedPayload {
  readonly runtimeCount: number;
  readonly resultCount: number;
  readonly durationMs: number;
  /**
   * Set when the turn was aborted before producing results (e.g. a
   * TurnStart-aborting hook such as cost-gate's hard budget cap). The client
   * surfaces this so an empty turn carries a visible reason instead of being
   * silently dropped. Absent on normal completions.
   */
  readonly abortReason?: string;
}

export interface RuntimeStartedPayload {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly kind?: string;
  readonly label?: string;
}

export interface RuntimeLifecyclePayload {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly status: string;
  readonly durationMs?: number;
}

export interface RuntimeFailedPayload extends RuntimeLifecyclePayload {
  readonly error?: string;
}

export interface AssetProgressPayload {
  readonly phase: string;
  readonly assetId?: string;
  readonly percent?: number;
  readonly message?: string;
  readonly modality?: string;
  readonly pluginId?: string;
  readonly runtimeId?: string;
  readonly turnId?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface AssetGeneratedPayload {
  readonly asset: Readonly<Record<string, unknown>>;
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
}

export interface EventEmittedPayload {
  readonly topic?: string;
  readonly type?: string;
  readonly eventType?: string;
  readonly data?: unknown;
  readonly pluginId?: string;
}

export interface WorldDimensionsChangedPayload {
  readonly worldId?: string;
}

export interface PluginDataChangedPayload {
  readonly pluginId: string;
  readonly changes: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface CharacterUpsertedPayload {
  readonly character: Readonly<Record<string, unknown>>;
  readonly runtimeId?: string;
  readonly pluginId?: string;
}

export interface ErrorOccurredPayload {
  readonly message: string;
}

export interface TurnSuspendedPayload {
  readonly suspensionId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly suspendedAt?: string;
  readonly reason?: string;
  readonly resumeSchema?: unknown;
}

export interface TurnResumedPayload {
  readonly suspensionId: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
}

export interface WorkingMemoryChangedPayload {
  /** Working-memory scope mirrored from the committed `working_memory.set`. */
  readonly scope: "player" | "story" | "shared";
  readonly key: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
}

export interface ProposalFailedPayload {
  /** Proposal envelope id that failed to commit. */
  readonly proposalId: string;
  /** Proposal type (e.g. `narrative.append`, `plugin.data`). */
  readonly proposalType: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly error: string;
}

export type CovelEvent =
  // Narrative
  | {
      readonly type: "narrative.delta";
      readonly payload: NarrativeDeltaPayload;
    }
  | {
      readonly type: "narrative.completed";
      readonly payload: NarrativeCompletedPayload;
    }
  // Interaction
  | {
      readonly type: "interaction.requested";
      readonly payload: InteractionRequestedPayload;
    }
  | {
      readonly type: "interaction.completed";
      readonly payload: CovelEventPayload;
    }
  // UI render parts
  | { readonly type: "ui.rendered"; readonly payload: UiRenderedPayload }
  | { readonly type: "ui.part.update"; readonly payload: CovelEventPayload }
  // State
  | { readonly type: "state.changed"; readonly payload: StateChangedPayload }
  | { readonly type: "state.snapshot"; readonly payload: CovelEventPayload }
  | {
      readonly type: "state.patch.applied";
      readonly payload: CovelEventPayload;
    }
  // Execution lifecycle
  | {
      readonly type: "execution.started";
      readonly payload: ExecutionStartedPayload;
    }
  | {
      readonly type: "runtime.started";
      readonly payload: RuntimeStartedPayload;
    }
  | {
      readonly type: "runtime.completed";
      readonly payload: RuntimeLifecyclePayload;
    }
  | { readonly type: "runtime.failed"; readonly payload: RuntimeFailedPayload }
  | {
      readonly type: "runtime.skipped";
      readonly payload: RuntimeLifecyclePayload;
    }
  | {
      readonly type: "execution.completed";
      readonly payload: ExecutionCompletedPayload;
    }
  // Asset lifecycle
  | { readonly type: "asset.progress"; readonly payload: AssetProgressPayload }
  | {
      readonly type: "asset.generated";
      readonly payload: AssetGeneratedPayload;
    }
  // Records / events
  | { readonly type: "record.updated"; readonly payload: CovelEventPayload }
  | { readonly type: "event.emitted"; readonly payload: EventEmittedPayload }
  // World
  | {
      readonly type: "world.dimensions.changed";
      readonly payload: WorldDimensionsChangedPayload;
    }
  // Plugin data
  | {
      readonly type: "plugin-data.changed";
      readonly payload: PluginDataChangedPayload;
    }
  // Character
  | {
      readonly type: "character.upserted";
      readonly payload: CharacterUpsertedPayload;
    }
  // Working memory. Emitted as a commit event (`working_memory.set` commit) and
  // written straight onto the action stream — so it MUST be a union member even
  // though the frontend action handler does not render it (UI reflects working
  // memory via `state.changed`). Was previously emitted but absent from the
  // union → hit the frontend `assertNeverEvent` guard on every commit.
  | {
      readonly type: "working_memory.changed";
      readonly payload: WorkingMemoryChangedPayload;
    }
  // Commit outcome : a proposal that failed to commit
  // is surfaced explicitly instead of being silently dropped. Written
  // directly onto the action stream by the commit-owning route.
  | {
      readonly type: "proposal.failed";
      readonly payload: ProposalFailedPayload;
    }
  // System
  | { readonly type: "error.occurred"; readonly payload: ErrorOccurredPayload }
  | {
      readonly type: "connection.restored";
      readonly payload: CovelEventPayload;
    }
  // Suspend / Resume
  | { readonly type: "turn.suspended"; readonly payload: TurnSuspendedPayload }
  | { readonly type: "turn.resumed"; readonly payload: TurnResumedPayload }
  // Snapshot / Fork
  | {
      readonly type: "state.snapshot.created";
      readonly payload: CovelEventPayload;
    }
  | { readonly type: "session.forked"; readonly payload: CovelEventPayload }
  // Runtime-internal trace events. These are forwarded onto the action stream
  // (see COVEL_EVENT_META) but the web action handler intentionally ignores
  // them — they drive the /debug timeline via the subscription channel.
  | { readonly type: "tool.calling"; readonly payload: CovelEventPayload }
  | { readonly type: "tool.completed"; readonly payload: CovelEventPayload }
  | { readonly type: "tool.failed"; readonly payload: CovelEventPayload }
  | { readonly type: "llm.calling"; readonly payload: CovelEventPayload }
  | { readonly type: "llm.responded"; readonly payload: CovelEventPayload }
  | { readonly type: "message.completed"; readonly payload: CovelEventPayload }
  | { readonly type: "block.emitted"; readonly payload: CovelEventPayload }
  | { readonly type: "hook.fired"; readonly payload: CovelEventPayload }
  | { readonly type: "hook.rewrote"; readonly payload: CovelEventPayload }
  | { readonly type: "hook.aborted"; readonly payload: CovelEventPayload }
  // Recursive-runtime trace events (TurnEmitter). Subscription-channel only —
  // NOT forwarded to the action stream (forwardToActionStream: false), so they
  // never reach the frontend action handler. Listed here so every framework
  // TurnEmitter emit type is a closed-union member and `emit()` can be typed
  // `CovelEventType`.
  | { readonly type: "recursive.calling"; readonly payload: CovelEventPayload }
  | {
      readonly type: "recursive.completed";
      readonly payload: CovelEventPayload;
    }
  | { readonly type: "recursive.failed"; readonly payload: CovelEventPayload }
  // Function-runtime trace events (TurnEmitter). `function.*` mark the handler
  // boundary (forward:false, like runtime.started/completed); `gateway.*` wrap
  // the function-runtime `ctx.gateway` provider calls (forward:true, mirroring
  // llm.calling/responded) so a function runtime's LLM usage is as visible in
  // the timeline as an agent runtime's. Emitted from
  // packages/runtime/src/function-runtime/gateway-trace.ts + turn-function-runtime.ts.
  | { readonly type: "function.executing"; readonly payload: CovelEventPayload }
  | { readonly type: "function.completed"; readonly payload: CovelEventPayload }
  | { readonly type: "gateway.calling"; readonly payload: CovelEventPayload }
  | { readonly type: "gateway.responded"; readonly payload: CovelEventPayload }
  | { readonly type: "gateway.failed"; readonly payload: CovelEventPayload }
  // Plugin-utils provider-call trace. Wraps
  // ctx.utils.fetchWithRetry — the wire image plugins own. Trace-only
  // (forward:false): polling can be high-frequency, so keep it off the action
  // stream; /debug reads it from trace_events + the subscription channel.
  | {
      readonly type: "utils.fetch.calling";
      readonly payload: CovelEventPayload;
    }
  | {
      readonly type: "utils.fetch.responded";
      readonly payload: CovelEventPayload;
    }
  | {
      readonly type: "utils.fetch.failed";
      readonly payload: CovelEventPayload;
    }
  // Prompt-assembly hard prune (TurnEmitter). Emitted once per runtime when the
  // assembled context did not fit the slot budget and history had to be dropped,
  // so /debug can explain a turn that lost context instead of silently losing it.
  // Trace-only (forward:false) — the player-facing stream is unaffected.
  | { readonly type: "context.pruned"; readonly payload: CovelEventPayload }
  // Kernel job-status channel (append-only). Emitted whenever a long-running
  // function runtime reports progress via `ctx.progress` — the sole real-time
  // exception to effects isolation. Forwarded to the action stream so media
  // generation progress reaches the client live. Payload is the full record.
  // Experimental / compat-period: coexists with the legacy `plugin-data` `_jobs`
  // placeholder path until that is retired.
  | { readonly type: "job-status.updated"; readonly payload: JobStatusRecord };

/** The closed vocabulary of every server→client event name. */
export type CovelEventType = CovelEvent["type"];

/**
 * Historical alias retained so existing imports keep working. New code should
 * prefer `CovelEventType`; both resolve to the same closed union.
 */
export type ProtocolEventType = CovelEventType;

export interface CovelEventMeta {
  /**
   * When true, an out-of-band EventBus event of this type is forwarded onto
   * the per-turn action SSE stream (`POST /api/actions`). Drives the server's
   * forwarding whitelist — see `FORWARDED_EVENT_TYPES`.
   */
  readonly forwardToActionStream: boolean;
}

/**
 * Per-event metadata, keyed by event name. The `satisfies Record<...>` clause
 * makes this map exhaustive over `CovelEventType`: adding a union member
 * without a meta entry (or a meta entry without a union member) fails to
 * compile. This is the knob that turns "add an SSE event" into a one-place,
 * compiler-enforced change.
 */
export const COVEL_EVENT_META = {
  "narrative.delta": { forwardToActionStream: false },
  "narrative.completed": { forwardToActionStream: false },
  "interaction.requested": { forwardToActionStream: false },
  "interaction.completed": { forwardToActionStream: false },
  "ui.rendered": { forwardToActionStream: true },
  "ui.part.update": { forwardToActionStream: false },
  "state.changed": { forwardToActionStream: false },
  "state.snapshot": { forwardToActionStream: false },
  "state.patch.applied": { forwardToActionStream: true },
  "execution.started": { forwardToActionStream: false },
  "runtime.started": { forwardToActionStream: false },
  "runtime.completed": { forwardToActionStream: false },
  "runtime.failed": { forwardToActionStream: false },
  "runtime.skipped": { forwardToActionStream: false },
  "execution.completed": { forwardToActionStream: false },
  "asset.progress": { forwardToActionStream: true },
  "asset.generated": { forwardToActionStream: false },
  "record.updated": { forwardToActionStream: false },
  "event.emitted": { forwardToActionStream: false },
  "world.dimensions.changed": { forwardToActionStream: true },
  "plugin-data.changed": { forwardToActionStream: true },
  "character.upserted": { forwardToActionStream: true },
  // Commit event written directly onto the action stream (not via the eventBus
  // forward path), so forwardToActionStream stays false — the flag only governs
  // eventBus→action-stream forwarding, which this event does not use.
  "working_memory.changed": { forwardToActionStream: false },
  // Direct write onto the action stream by the commit-owning route (like
  // working_memory.changed) — the flag only governs eventBus forwarding.
  "proposal.failed": { forwardToActionStream: false },
  "error.occurred": { forwardToActionStream: false },
  "connection.restored": { forwardToActionStream: false },
  "turn.suspended": { forwardToActionStream: true },
  "turn.resumed": { forwardToActionStream: true },
  "state.snapshot.created": { forwardToActionStream: false },
  "session.forked": { forwardToActionStream: false },
  "tool.calling": { forwardToActionStream: true },
  "tool.completed": { forwardToActionStream: true },
  "tool.failed": { forwardToActionStream: true },
  "llm.calling": { forwardToActionStream: true },
  "llm.responded": { forwardToActionStream: true },
  "message.completed": { forwardToActionStream: true },
  "block.emitted": { forwardToActionStream: true },
  "hook.fired": { forwardToActionStream: true },
  "hook.rewrote": { forwardToActionStream: true },
  "hook.aborted": { forwardToActionStream: true },
  // Subscription-channel-only trace events — intentionally NOT forwarded to the
  // action stream (behaviour preserved from before they joined the union).
  "recursive.calling": { forwardToActionStream: false },
  "recursive.completed": { forwardToActionStream: false },
  "recursive.failed": { forwardToActionStream: false },
  // Function-runtime trace events (see CovelEvent union). function.* mark the
  // handler boundary (trace-only); gateway.* wrap provider calls and forward to
  // the action stream for agent/function parity with llm.calling/responded.
  "function.executing": { forwardToActionStream: false },
  "function.completed": { forwardToActionStream: false },
  "gateway.calling": { forwardToActionStream: true },
  "gateway.responded": { forwardToActionStream: true },
  "gateway.failed": { forwardToActionStream: true },
  // Plugin-utils fetch trace — trace-only (not forwarded; can be high-frequency).
  "utils.fetch.calling": { forwardToActionStream: false },
  "utils.fetch.responded": { forwardToActionStream: false },
  "utils.fetch.failed": { forwardToActionStream: false },
  // Prompt-budget prune trace — /debug only.
  "context.pruned": { forwardToActionStream: false },
  // Kernel job-status progress — forwarded live so media-generation progress
  // reaches the client without waiting for the domain commit.
  "job-status.updated": { forwardToActionStream: true },
} satisfies Record<CovelEventType, CovelEventMeta>;

/**
 * Event types forwarded from the out-of-band EventBus onto the per-turn action
 * SSE stream. DERIVED from `COVEL_EVENT_META` — the server must consume this
 * rather than hand-maintain a parallel Set (the previous `FORWARDED_SUBTYPES`).
 */
export const FORWARDED_EVENT_TYPES: ReadonlySet<CovelEventType> = new Set(
  (
    Object.entries(COVEL_EVENT_META) as ReadonlyArray<
      readonly [CovelEventType, CovelEventMeta]
    >
  )
    .filter(([, meta]) => meta.forwardToActionStream)
    .map(([type]) => type),
);

export interface ProtocolEvent {
  readonly id: string;
  readonly type: ProtocolEventType;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly source?: { readonly pluginId: string; readonly runtimeId: string };
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

// ── Session Snapshot (for restore/reconnection) ─────────────────

/**
 * Keyset cursor for backward pagination over an append-only, time-ordered log.
 * The `(createdAt, id)` tuple is a total order even when rows share a
 * millisecond, so paging by it never skips or repeats a row. Pass it as the
 * `before` position to fetch the page immediately older than the current one.
 */
export interface TimeCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * A keyset page of an append-only log. `items` are oldest-first; `nextCursor`
 * is the position to request the next (older) page, or `null` when the returned
 * window already reaches the start of history.
 */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: TimeCursor | null;
}

export interface SessionSnapshot {
  readonly session: {
    readonly id: string;
    readonly worldId?: string;
    readonly turnCount: number;
    readonly locale?: string;
  };
  readonly messages: readonly SnapshotMessage[];
  /**
   * Cursor for loading messages older than `messages` (which is the most-recent
   * window, not the full history). `null` when the window already reaches the
   * start of the chat — i.e. there is nothing older to load.
   */
  readonly messagesCursor?: TimeCursor | null;
  readonly characters: readonly SnapshotCharacter[];
  readonly gameState: Readonly<Record<string, unknown>>;
  readonly executionSteps: readonly SnapshotTraceEvent[];
  readonly plugins: readonly SnapshotPluginStatus[];
  /** Character attribute schema from world-data-provider plugin (if available). */
  readonly characterSchema?: Readonly<Record<string, unknown>>;
}

export interface SnapshotMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly kind?: string;
  readonly block?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface SnapshotCharacter {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface SnapshotTraceEvent {
  readonly type: string;
  readonly turnId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export interface SnapshotPluginStatus {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  /** Named stage; absent for event/manual/UI-only plugins. */
  readonly stage?: import("./runtime-scheduling.js").Stage;
  /** Kept until Step 6; `stage` is the replacement order axis. */
  readonly priority: number;
}
