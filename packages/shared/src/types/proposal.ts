/**
 * Proposal types — the stable "instruction set" of the Session Kernel.
 *
 * Every runtime output is normalized into Proposal[], committed through
 * the Kernel pipeline, persisted to Store, and emitted as SessionEvent[].
 *
 * Inspired by: Z-machine (stable intermediate representation),
 * Bevy ECS (deferred Commands), Bukkit (priority event chain).
 */

// ── Proposal Type Enum ──────────────────────────────────────────

export type ProposalType =
  | 'narrative.append'
  | 'narrative.template'
  | 'state.patch'
  | 'event.emit'
  | 'record.upsert'
  | 'interaction.request'
  | 'ui.render'
  | 'asset.generate'
  | 'phase.transition'
  | 'plugin.data';

// ── Proposal ────────────────────────────────────────────────────

export interface ProposalSource {
  readonly pluginId: string;
  readonly runtimeId: string;
}

export interface Proposal {
  readonly id: string;
  readonly type: ProposalType;
  readonly source: ProposalSource;
  readonly turnId: string;
  readonly sessionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

// ── Type-specific Payload Interfaces ────────────────────────────

export interface NarrativeAppendPayload {
  readonly content: string;
  readonly kind: string;       // 'story' | 'plugin' | custom
}

export interface InteractionRequestPayload {
  readonly interactionId: string;
  readonly type: 'form' | 'choice' | 'confirmation';
  readonly title?: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly narrativeTemplate?: string;
}

export interface StatePatchPayload {
  readonly table: string;
  readonly field: string;
  readonly value: unknown;
  readonly reason?: string;
}

export interface PhaseTransitionPayload {
  readonly phase: string;
}

export interface EventEmitPayload {
  readonly topic: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RecordUpsertPayload {
  readonly recordType: 'character' | 'quest' | 'item' | 'location';
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PluginDataPayload {
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
}

// ── SessionEvent (emitted to clients after commit) ──────────────

export interface SessionEvent {
  readonly id: string;             // monotonic, supports replay
  readonly type: string;           // event type (e.g. 'narrative.completed')
  readonly sessionId: string;
  readonly turnId: string;
  readonly source: ProposalSource;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

// ── Commit Result ───────────────────────────────────────────────

export interface CommitResult {
  readonly committed: boolean;
  readonly event?: SessionEvent;
  readonly error?: string;
}
