/**
 * Proposal types — the stable "instruction set" of the Session Kernel.
 *
 * Every runtime output is normalized into Proposal[], committed through
 * the Kernel pipeline, persisted to Store, and emitted as SessionEvent[].
 *
 * Inspired by: Z-machine (stable intermediate representation),
 * Bevy ECS (deferred Commands), Bukkit (priority event chain).
 *
 * ── Single source of truth ──────────────────────────────────────
 * `ProposalPayloadMap` is the ONE place that pairs every proposal `type`
 * with its payload shape. Everything else is derived from it:
 *   - `ProposalType`   = `keyof ProposalPayloadMap`
 *   - `Proposal`       = discriminated union (each variant correlates
 *                         `type` ↔ `payload`)
 *   - `PROPOSAL_TYPES` = runtime list, exhaustiveness-checked against the map
 * The commit-handler registry (`@covel/runtime`) is likewise keyed by
 * `ProposalType` via `satisfies`, so adding a proposal type forces a
 * matching handler at compile time. Never hand-maintain a parallel list.
 */

import type { MediaRef } from "./media.js";
import type { UIRenderPartsInstruction } from "./ui.js";

// ── Proposal Source ─────────────────────────────────────────────

export interface ProposalSource {
  readonly pluginId: string;
  readonly runtimeId: string;
}

// ── Type-specific Payload Interfaces ────────────────────────────

export interface NarrativeAppendPayload {
  readonly content: string;
  readonly kind: string; // 'story' | 'plugin' | custom
}

export interface InteractionRequestPayload {
  readonly interactionId: string;
  readonly type: "form" | "choice" | "confirmation";
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

export type UIRenderPayload = UIRenderPartsInstruction;

export interface AssetGeneratePayload {
  readonly ref: MediaRef;
  readonly modality: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface PluginDataPayload {
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
}

export interface PluginDataBatchPayload {
  readonly items: readonly PluginDataPayload[];
}

export interface CharacterUpsertPayload {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly description?: string;
  readonly fields?: unknown;
  readonly version?: number;
  readonly createdAt?: string;
  /**
   * Optional plugin-data mirror target. When provided, the commit handler
   * mirrors a compact character snapshot into this plugin's
   * `characters/<id>` namespace so existing plugin UI panels can update via
   * the standard `plugin-data.changed` channel.
   */
  readonly mirrorPluginId?: string;
  /**
   * Additional plugin-data mirror targets for framework panels that aggregate
   * characters across multiple character-producing plugins.
   */
  readonly mirrorPluginIds?: readonly string[];
}

export interface WorkingMemorySetPayload {
  readonly scope: "player" | "story" | "shared";
  readonly key: string;
  readonly value: unknown;
  readonly schemaRef?: string;
}

/**
 * Payload for `lorebook.upsert` proposals.
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
  readonly strategy: "constant" | "selective";
  readonly position?: string; // defaults to 'after_char_defs'
  readonly insertionOrder?: number; // defaults to 100
  readonly enabled?: boolean; // defaults to true
  readonly keys?: readonly string[];
  /** Free-form forward-compatible fields (atDepth, budgetCap, …). */
  readonly extra?: unknown;
}

// ── Proposal Payload Map (SINGLE SOURCE OF TRUTH) ───────────────
//
// Add a proposal type here and the rest of the system follows:
//   1. `ProposalType` gains the key automatically.
//   2. `Proposal` gains the correlated `{ type; payload }` variant.
//   3. The commit-handler registry's `satisfies` fails until you add a
//      handler (compile error in @covel/runtime).
//   4. `PROPOSAL_TYPES` below fails to compile until you list it here too,
//      keeping the discovery advertisement honest.

export interface ProposalPayloadMap {
  "narrative.append": NarrativeAppendPayload;
  "state.patch": StatePatchPayload;
  "event.emit": EventEmitPayload;
  "interaction.request": InteractionRequestPayload;
  "ui.render": UIRenderPayload;
  "asset.generate": AssetGeneratePayload;
  "plugin.data": PluginDataPayload;
  "plugin.data.batch": PluginDataBatchPayload;
  "character.upsert": CharacterUpsertPayload;
  "working_memory.set": WorkingMemorySetPayload;
  "lorebook.upsert": LorebookUpsertPayload;
}

export type ProposalType = keyof ProposalPayloadMap;

/**
 * A single proposal envelope for proposal type `K`. `type` and `payload`
 * are correlated, so narrowing on `type` precisely narrows `payload`.
 */
export type ProposalFor<K extends ProposalType = ProposalType> = {
  readonly id: string;
  readonly type: K;
  readonly source: ProposalSource;
  readonly turnId: string;
  readonly sessionId: string;
  readonly payload: ProposalPayloadMap[K];
  readonly timestamp: string;
};

/**
 * Discriminated union over every proposal type. Switching on `proposal.type`
 * narrows `proposal.payload` to the matching interface — no `as` casts needed
 * in commit handlers or other consumers.
 */
export type Proposal = { [K in ProposalType]: ProposalFor<K> }[ProposalType];

/**
 * Runtime list of every proposal type. This is the value-level mirror of
 * `ProposalType` (which has no runtime representation) and is consumed by the
 * discovery endpoint so clients are told exactly what the kernel can commit.
 *
 * `satisfies` rejects any entry that is not a real `ProposalType`; the
 * exhaustiveness guard below rejects any `ProposalType` that is missing from
 * the list. Together they keep this list exactly in lock-step with the map.
 */
export const PROPOSAL_TYPES = [
  "narrative.append",
  "state.patch",
  "event.emit",
  "interaction.request",
  "ui.render",
  "asset.generate",
  "plugin.data",
  "plugin.data.batch",
  "character.upsert",
  "working_memory.set",
  "lorebook.upsert",
] as const satisfies readonly ProposalType[];

// Compile-time exhaustiveness guard. If a type is added to
// `ProposalPayloadMap` but not to `PROPOSAL_TYPES`, `ProposalType` no longer
// extends the listed union and this alias fails to compile (TS2344).
type AssertExtends<A extends B, B> = A;
type _ProposalTypesExhaustive = AssertExtends<
  ProposalType,
  (typeof PROPOSAL_TYPES)[number]
>;

// ── SessionEvent (emitted to clients after commit) ──────────────

export interface SessionEvent {
  readonly id: string; // monotonic, supports replay
  readonly type: string; // event type (e.g. 'narrative.completed')
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
