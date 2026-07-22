/**
 * IndexedDB scheduling-redesign lifecycle store (logical-turn ledger, setup
 * attempts, job status).
 *
 * Each object store uses a composite array keyPath as its primary key, which
 * natively enforces the same uniqueness the SQL unique indexes do — so an
 * insert-if-absent is a `get(compositeKey)` then `put` (idempotent: a present
 * key returns `false`). Optional fields are canonicalised to absent-when-null on
 * write (shared canonicalisers) so records round-trip identically to the SQL
 * backends. Reads walk the `sessionId` index and sort in JS to match the SQL
 * `ORDER BY`.
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
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbLifecycleStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async insertLogicalTurnCompletion(
      record: LogicalTurnLedgerRecord,
    ): Promise<boolean> {
      await mutations.ensureStoreSnapshot("logical_turn_ledger");
      const tx = db.transaction("logical_turn_ledger", "readwrite");
      const existing = await tx.store.get([
        record.sessionId,
        record.logicalTurnId,
      ]);
      if (existing) {
        await tx.done;
        return false;
      }
      await tx.store.put(structuredClone(record));
      await tx.done;
      return true;
    },

    async getLogicalTurnCompletion(
      sessionId: string,
      logicalTurnId: string,
    ): Promise<LogicalTurnLedgerRecord | null> {
      const row = (await db.get("logical_turn_ledger", [
        sessionId,
        logicalTurnId,
      ])) as LogicalTurnLedgerRecord | undefined;
      return row ?? null;
    },

    async insertSetupAttempt(record: SetupAttemptRecord): Promise<boolean> {
      await mutations.ensureStoreSnapshot("setup_attempts");
      const tx = db.transaction("setup_attempts", "readwrite");
      const existing = await tx.store.get([
        record.sessionId,
        record.runtimeId,
        record.generation,
        record.executionId,
      ]);
      if (existing) {
        await tx.done;
        return false;
      }
      await tx.store.put(structuredClone(canonicalSetupAttempt(record)));
      await tx.done;
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
    ): Promise<void> {
      await mutations.ensureStoreSnapshot("setup_attempts");
      const tx = db.transaction("setup_attempts", "readwrite");
      const existing = (await tx.store.get([
        sessionId,
        runtimeId,
        generation,
        executionId,
      ])) as SetupAttemptRecord | undefined;
      if (!existing) {
        await tx.done;
        return;
      }
      // Partial update: `state` always; `finishedAt`/`error` only when present
      // in the patch (nullish clears to absent), else preserved.
      const next = canonicalSetupAttempt({
        ...existing,
        state: patch.state,
        finishedAt:
          "finishedAt" in patch ? patch.finishedAt : existing.finishedAt,
        error: "error" in patch ? patch.error : existing.error,
      });
      await tx.store.put(structuredClone(next));
      await tx.done;
    },

    async listSetupAttempts(
      sessionId: string,
      filter?: { readonly runtimeId?: string; readonly generation?: number },
    ): Promise<readonly SetupAttemptRecord[]> {
      const rows = (await db.getAllFromIndex(
        "setup_attempts",
        "sessionId",
        sessionId,
      )) as SetupAttemptRecord[];
      return rows
        .filter(
          (r) =>
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

    async appendJobStatus(record: JobStatusRecord): Promise<boolean> {
      await mutations.ensureStoreSnapshot("job_status");
      const tx = db.transaction("job_status", "readwrite");
      const existing = await tx.store.get([
        record.sessionId,
        record.progressScopeId,
        record.pluginId,
        record.runtimeId,
        record.jobId,
        record.sequence,
      ]);
      if (existing) {
        await tx.done;
        return false;
      }
      await tx.store.put(structuredClone(canonicalJobStatus(record)));
      await tx.done;
      return true;
    },

    async listJobStatus(
      sessionId: string,
      filter?: { readonly progressScopeId?: string; readonly jobId?: string },
    ): Promise<readonly JobStatusRecord[]> {
      const rows = (await db.getAllFromIndex(
        "job_status",
        "sessionId",
        sessionId,
      )) as JobStatusRecord[];
      return rows
        .filter(
          (r) =>
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
