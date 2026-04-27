/**
 * Narrow store interface consumed by `@covel/context`.
 *
 * `@covel/context` must not depend on `@covel/store`. Instead it declares
 * the minimal subset of read/write operations it actually needs and lets
 * structural typing match the concrete `DataStore` from `@covel/store`
 * at the composition root (server, plugin tests).
 *
 * Mirrors the `KernelStore` pattern in `@covel/runtime` —
 * see `packages/runtime/src/session-kernel.ts`.
 *
 * Only methods invoked by `session-context.ts`, `session-context-views.ts`,
 * `prompt-internals.ts`, and `compactor.ts` belong here. Adding a new store
 * call from inside `@covel/context` requires extending this interface and
 * re-running structural-compat checks against `DataStore`.
 *
 * Record types are declared locally as plain wire shapes (no `Date`, no DB
 * driver types — ISO timestamps as `string`). They are intentional supersets
 * compatible with the `@covel/store` records via structural typing.
 */

import type {
  CharacterSummaryRecord,
  LorebookEntryRecord,
  PluginDataRecord,
  PlayerInputRecord,
  SessionRecord,
  SessionSummaryRecord,
  TraceEventRecord,
  TurnMessageRecord,
  WorkingMemoryRecord,
  WorldRecord,
} from './store-records.js';

export interface SessionContextStore {
  // ── Reads (session-context.ts / session-context-views.ts) ───────
  getSession(sessionId: string): Promise<SessionRecord | null>;
  getWorld(worldId: string): Promise<WorldRecord | null>;
  listCharacters(sessionId: string): Promise<readonly CharacterSummaryRecord[]>;
  listPlayerInputs(sessionId: string): Promise<readonly PlayerInputRecord[]>;
  listPluginData(
    sessionId: string,
    pluginId: string,
    namespace: string,
  ): Promise<readonly PluginDataRecord[]>;
  /**
   * Optional — older mock stores in plugin tests may not implement this.
   * Loader probes via `typeof === 'function'` before invoking.
   */
  listWorkingMemory?(sessionId: string): Promise<readonly WorkingMemoryRecord[]>;
  /**
   * Optional — same rationale as `listWorkingMemory`.
   */
  listSessionLorebookEntries?(
    sessionId: string,
  ): Promise<readonly LorebookEntryRecord[]>;

  // ── Writes (compactor.ts) ───────────────────────────────────────
  saveSessionSummary(record: SessionSummaryRecord): Promise<void>;
  tagTurnMessagesCompacted(
    sessionId: string,
    messageIds: readonly string[],
    summaryId: string,
  ): Promise<void>;
  addTraceEvent(record: TraceEventRecord): Promise<void>;
}

// Re-export the local record shapes so existing imports inside
// `@covel/context` keep working without a bare `@covel/store` reference.
export type {
  CharacterSummaryRecord,
  LorebookEntryRecord,
  PluginDataRecord,
  PlayerInputRecord,
  SessionRecord,
  SessionSummaryRecord,
  TraceEventRecord,
  TurnMessageRecord,
  WorkingMemoryRecord,
  WorldRecord,
} from './store-records.js';
