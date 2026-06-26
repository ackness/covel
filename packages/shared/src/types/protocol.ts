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

export interface ExecutionCompletedPayload {
  readonly runtimeCount: number;
  readonly resultCount: number;
  readonly durationMs: number;
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
  // System
  | { readonly type: "error.occurred"; readonly payload: ErrorOccurredPayload }
  | {
      readonly type: "connection.restored";
      readonly payload: CovelEventPayload;
    }
  // Suspend / Resume (S4-T4)
  | { readonly type: "turn.suspended"; readonly payload: TurnSuspendedPayload }
  | { readonly type: "turn.resumed"; readonly payload: TurnResumedPayload }
  // Snapshot / Fork (S4-T2 / S4-T5)
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
  | { readonly type: "hook.aborted"; readonly payload: CovelEventPayload };

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

export interface SessionSnapshot {
  readonly session: {
    readonly id: string;
    readonly worldId?: string;
    readonly turnCount: number;
    readonly locale?: string;
  };
  readonly messages: readonly SnapshotMessage[];
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
  readonly priority: number;
}
