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
  | 'plugin.data'
  | 'working_memory.set'
  | 'lorebook.upsert';

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

export interface WorkingMemorySetPayload {
  readonly scope: 'player' | 'story' | 'shared';
  readonly key: string;
  readonly value: unknown;
  readonly schemaRef?: string;
}

/**
 * Payload for `lorebook.upsert` proposals (S3-T2).
 *
 * Each entry in `entries` becomes one row in the `lorebook_entries` table.
 * The commit handler stamps the proposal's `sessionId` and the source
 * plugin's `pluginId` automatically — callers do not need to repeat them
 * inside each entry.
 *
 * Fields here mirror the store-layer `LorebookEntryRecord` shape so the
 * kernel can emit lorebook upserts without reaching into store internals.
 */
export interface LorebookUpsertPayload {
  readonly entries: readonly LorebookUpsertEntry[];
}

export interface LorebookUpsertEntry {
  /** Stable id; re-using an existing id replaces the previous entry. */
  readonly id: string;
  readonly content: string;
  readonly strategy: 'constant' | 'selective';
  readonly position?: string;       // defaults to 'after_char_defs'
  readonly insertionOrder?: number; // defaults to 100
  readonly enabled?: boolean;       // defaults to true
  readonly keys?: readonly string[];
  /** Free-form forward-compatible fields (atDepth, budgetCap, …). */
  readonly extra?: unknown;
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
