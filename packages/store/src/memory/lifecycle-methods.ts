/**
 * MemoryStore scheduling-redesign lifecycle methods (logical-turn ledger,
 * setup attempts, job status).
 *
 * Each collection is a `Map` keyed by the record's composite unique key, so an
 * insert is idempotent (a present key returns `false` without overwriting),
 * exactly mirroring the SQL unique indexes. Optional fields are canonicalised to
 * "absent when null/undefined" on write (via the shared canonicalisers) so a
 * `data: null` (or missing optional) round-trips identically to the SQL
 * backends, whose nullable columns collapse `null` → absent on read. Backend
 * parity is a hard contract.
 */

import {
  canonicalJobStatus,
  canonicalSetupAttempt,
} from "../common/mappers/lifecycle-mappers.js";
import type {
  JobStatusRecord,
  LogicalTurnLedgerRecord,
  SetupAttemptRecord,
  SetupAttemptState,
} from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

// Map keys are JSON-serialised composite-key tuples — collision-free regardless
// of identifier contents (no separator character to clash with).
function ledgerKey(sessionId: string, logicalTurnId: string): string {
  return JSON.stringify([sessionId, logicalTurnId]);
}

function attemptKey(
  sessionId: string,
  runtimeId: string,
  generation: number,
  executionId: string,
): string {
  return JSON.stringify([sessionId, runtimeId, generation, executionId]);
}

function jobKey(r: JobStatusRecord): string {
  return JSON.stringify([
    r.sessionId,
    r.progressScopeId,
    r.pluginId,
    r.runtimeId,
    r.jobId,
    r.sequence,
  ]);
}

export function createLifecycleMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async insertLogicalTurnCompletion(record: LogicalTurnLedgerRecord) {
      const key = ledgerKey(record.sessionId, record.logicalTurnId);
      if (state.logicalTurnLedger.has(key)) return false;
      state.logicalTurnLedger.set(key, record);
      return true;
    },

    async getLogicalTurnCompletion(sessionId: string, logicalTurnId: string) {
      return (
        state.logicalTurnLedger.get(ledgerKey(sessionId, logicalTurnId)) ?? null
      );
    },

    async insertSetupAttempt(record: SetupAttemptRecord) {
      const key = attemptKey(
        record.sessionId,
        record.runtimeId,
        record.generation,
        record.executionId,
      );
      if (state.setupAttempts.has(key)) return false;
      state.setupAttempts.set(key, canonicalSetupAttempt(record));
      return true;
    },

    async updateSetupAttempt(
      sessionId: string,
      runtimeId: string,
      generation: number,
      executionId: string,
      patch: {
        readonly state: SetupAttemptState;
        readonly finishedAt?: string;
        readonly error?: string;
      },
    ) {
      const key = attemptKey(sessionId, runtimeId, generation, executionId);
      const existing = state.setupAttempts.get(key);
      if (!existing) return;
      // Partial update: `state` always; `finishedAt`/`error` only when the key
      // is present in the patch (nullish clears to absent), else preserved.
      state.setupAttempts.set(
        key,
        canonicalSetupAttempt({
          ...existing,
          state: patch.state,
          finishedAt:
            "finishedAt" in patch ? patch.finishedAt : existing.finishedAt,
          error: "error" in patch ? patch.error : existing.error,
        }),
      );
    },

    async listSetupAttempts(
      sessionId: string,
      filter?: { readonly runtimeId?: string; readonly generation?: number },
    ) {
      return [...state.setupAttempts.values()]
        .filter(
          (r) =>
            r.sessionId === sessionId &&
            (filter?.runtimeId === undefined ||
              r.runtimeId === filter.runtimeId) &&
            (filter?.generation === undefined ||
              r.generation === filter.generation),
        )
        .sort(
          (a, b) =>
            a.startedAt.localeCompare(b.startedAt) ||
            a.executionId.localeCompare(b.executionId),
        );
    },

    async appendJobStatus(record: JobStatusRecord) {
      const key = jobKey(record);
      if (state.jobStatus.has(key)) return false;
      state.jobStatus.set(key, canonicalJobStatus(record));
      return true;
    },

    async listJobStatus(
      sessionId: string,
      filter?: { readonly progressScopeId?: string; readonly jobId?: string },
    ) {
      return [...state.jobStatus.values()]
        .filter(
          (r) =>
            r.sessionId === sessionId &&
            (filter?.progressScopeId === undefined ||
              r.progressScopeId === filter.progressScopeId) &&
            (filter?.jobId === undefined || r.jobId === filter.jobId),
        )
        .sort(
          (a, b) => a.jobId.localeCompare(b.jobId) || a.sequence - b.sequence,
        );
    },
  };
}
