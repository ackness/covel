/**
 * Working-memory, world-data ledger, lorebook, summary, turn-message and
 * player-input record types.
 *
 * Split out of `../types.ts` by domain; re-exported there for compatibility.
 */

export interface WorkingMemoryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly key: string;
  readonly scope: "player" | "story" | "shared";
  readonly value: unknown; // validated by schema_ref when present
  readonly schemaRef?: string;
  readonly updatedAt: string; // ISO
}

/**
 * Canonical working-memory ordering: by semantic scope (player → story →
 * shared) then key. Every backend's `listWorkingMemory` sorts with this so the
 * order entries are surfaced (and injected into prompts) is identical across
 * Memory / SQLite / PG / IDB — alphabetical scope ordering would put `shared`
 * before `story` only on the SQL backends, breaking parity.
 */
export const WORKING_MEMORY_SCOPE_ORDER: Readonly<Record<string, number>> = {
  player: 0,
  story: 1,
  shared: 2,
};

export function compareWorkingMemoryEntries(
  a: { readonly scope: string; readonly key: string },
  b: { readonly scope: string; readonly key: string },
): number {
  const scopeDiff =
    (WORKING_MEMORY_SCOPE_ORDER[a.scope] ?? 99) -
    (WORKING_MEMORY_SCOPE_ORDER[b.scope] ?? 99);
  if (scopeDiff !== 0) return scopeDiff;
  return a.key.localeCompare(b.key);
}

export interface WorldDataImportLedgerRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly target: string;
  readonly pluginId?: string;
  readonly namespace?: string;
  readonly key?: string;
  readonly sourceWorldId: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly valueHash: string;
  readonly schemaRef?: string;
  readonly derivedFrom?: readonly string[];
  readonly importedAt: string;
  readonly managed: boolean;
}

/**
 * Session-scoped lorebook entry persisted to the store (S3-T2).
 *
 * Plain record shape carrying all lorebook entry fields. The framework
 * routes and runtime/loader handle field-level semantics; the store layer
 * just persists and retrieves these records by (sessionId, id).
 *
 * Only session-source entries land here. World/plugin layer entries are
 * loaded from disk by the lorebook loaders and never persisted via this
 * table — A3 keeps them as authoring artefacts, not session state.
 */
export interface LorebookEntryRecord {
  readonly id: string;
  readonly sessionId: string;
  /** Plugin that owns this entry. Mirrors lorebook `pluginId` for traceability. */
  readonly pluginId: string;
  /** JSON string[] — keys for selective scanning (constant entries can pass `[]`). */
  readonly keys: readonly string[];
  readonly content: string;
  readonly strategy: "constant" | "selective";
  readonly position: string; // LorebookPosition — keep stringly-typed at the store edge
  readonly insertionOrder: number;
  readonly enabled: boolean;
  /** Free-form JSON for forward-compatible fields (atDepth, budgetCap, etc.). */
  readonly extra?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Turn Messages (append-only conversation history) ─────────────

export interface TurnMessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sourceType: string; // 'system' | 'runtime' | 'player' | 'tool' | 'player-input'
  readonly sourcePluginId?: string;
  readonly sourceRuntimeId?: string;
  readonly role: string; // 'system' | 'user' | 'assistant'
  readonly name?: string;
  readonly content: string;
  readonly ui?: unknown; // JSON — UIRenderInstruction[]
  readonly pendingInput?: unknown; // JSON — PlayerInputForm
  readonly order: number;
  readonly createdAt: string;
  /**
   * When set, this message has been compacted into a session summary.
   * The value is the `SessionSummaryRecord.id` that replaced this message.
   * The original content is preserved; only the prompt-build path substitutes
   * the summary in place of the compacted message span (S2-T2 Compactor).
   */
  readonly compactedAtTurnId?: string; // summaryId, not a turn ID despite the name
}

// ── Session Summaries (S2-T2 Compactor) ─────────────────────────

export interface SessionSummaryRecord {
  readonly id: string;
  readonly sessionId: string;
  /** First compacted turnId (inclusive). */
  readonly turnRangeStart: string;
  /** Last compacted turnId (inclusive). */
  readonly turnRangeEnd: string;
  /** The summary text produced by the fast-slot LLM. */
  readonly content: string;
  /** Deduped list from plugin summaryFocus fields. */
  readonly focusSections: readonly string[];
  readonly createdAt: string;
}

export interface PlayerInputRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly formId: string;
  readonly values: unknown; // JSON — Record<string, unknown>
  readonly createdAt: string;
}
