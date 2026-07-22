/**
 * Backend-agnostic scheduling-redesign lifecycle records, shared by the
 * PostgreSQL and SQLite backends: the logical-turn completion ledger, the
 * setup-runtime attempt log, and the append-only job-status stream.
 *
 * The three insert paths are idempotent — they route through
 * {@link SqlRunner.insertIgnoreReturningCount} (`ON CONFLICT DO NOTHING`,
 * returning the affected count) so a duplicate key is a no-op that reports
 * `false`, never a throw. Reads and the setup-attempt terminalising UPDATE use
 * the same uniform {@link SqlRunner} surface as the other record modules.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Column, SQL, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import {
  toJobStatusRecord,
  toLogicalTurnLedgerRecord,
  toSetupAttemptRecord,
} from "./mappers.js";
import type {
  JobStatusRow,
  LogicalTurnLedgerRow,
  SetupAttemptRow,
} from "./mappers/lifecycle-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type {
  DataStore,
  JobStatusRecord,
  LogicalTurnLedgerRecord,
  SetupAttemptRecord,
} from "../types.js";

type LogicalTurnLedgerTable = Table & {
  sessionId: Column;
  logicalTurnId: Column;
};

type SetupAttemptsTable = Table & {
  sessionId: Column;
  runtimeId: Column;
  generation: Column;
  executionId: Column;
  startedAt: Column;
};

type JobStatusTable = Table & {
  sessionId: Column;
  progressScopeId: Column;
  pluginId: Column;
  runtimeId: Column;
  jobId: Column;
  sequence: Column;
};

export interface SqlLifecycleTables {
  readonly logicalTurnLedger: LogicalTurnLedgerTable;
  readonly setupAttempts: SetupAttemptsTable;
  readonly jobStatus: JobStatusTable;
}

export interface SqlLifecycleRecordsDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlLifecycleTables;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    "logicalTurnLedgerInsert" | "setupAttemptInsert" | "jobStatusInsert"
  >;
}

export type SqlLifecycleRecords = Pick<
  DataStore,
  | "insertLogicalTurnCompletion"
  | "getLogicalTurnCompletion"
  | "insertSetupAttempt"
  | "updateSetupAttempt"
  | "listSetupAttempts"
  | "appendJobStatus"
  | "listJobStatus"
>;

/** `and(...conds)` over the defined predicates, or `undefined` when none. */
function allOf(conds: readonly (SQL | undefined)[]): SQL | undefined {
  const defined = conds.filter((c): c is SQL => c !== undefined);
  return defined.length > 0 ? and(...defined) : undefined;
}

export function createSqlLifecycleRecords(
  deps: SqlLifecycleRecordsDeps,
): SqlLifecycleRecords {
  const { runner, tables, json, values } = deps;
  const { logicalTurnLedger, setupAttempts, jobStatus } = tables;

  return {
    // ── Logical-turn completion ledger ───────────────────────────
    async insertLogicalTurnCompletion(
      record: LogicalTurnLedgerRecord,
    ): Promise<boolean> {
      const inserted = await runner.insertIgnoreReturningCount(
        logicalTurnLedger,
        values.logicalTurnLedgerInsert(record),
        [logicalTurnLedger.sessionId, logicalTurnLedger.logicalTurnId],
      );
      return inserted === 1;
    },

    async getLogicalTurnCompletion(
      sessionId: string,
      logicalTurnId: string,
    ): Promise<LogicalTurnLedgerRecord | null> {
      const row = await runner.selectFirst<LogicalTurnLedgerRow>(
        logicalTurnLedger,
        {
          where: and(
            eq(logicalTurnLedger.sessionId, sessionId),
            eq(logicalTurnLedger.logicalTurnId, logicalTurnId),
          ),
        },
      );
      return row ? toLogicalTurnLedgerRecord(row) : null;
    },

    // ── Setup-runtime attempts ───────────────────────────────────
    async insertSetupAttempt(record: SetupAttemptRecord): Promise<boolean> {
      const inserted = await runner.insertIgnoreReturningCount(
        setupAttempts,
        values.setupAttemptInsert(record),
        [
          setupAttempts.sessionId,
          setupAttempts.runtimeId,
          setupAttempts.generation,
          setupAttempts.executionId,
        ],
      );
      return inserted === 1;
    },

    async updateSetupAttempt(
      sessionId: string,
      runtimeId: string,
      generation: number,
      executionId: string,
      patch: Parameters<DataStore["updateSetupAttempt"]>[4],
    ): Promise<void> {
      // Partial update: `state` always, `finishedAt`/`error` only when the
      // caller supplied the key (mirrors sessionUpdate's `"x" in patch`). A
      // terminalising caller passes finishedAt; a mid-flight transition may not.
      const set: Record<string, unknown> = { state: patch.state };
      if ("finishedAt" in patch) set.finishedAt = patch.finishedAt ?? null;
      if ("error" in patch) set.error = patch.error ?? null;
      await runner.update(
        setupAttempts,
        set,
        and(
          eq(setupAttempts.sessionId, sessionId),
          eq(setupAttempts.runtimeId, runtimeId),
          eq(setupAttempts.generation, generation),
          eq(setupAttempts.executionId, executionId),
        ),
      );
    },

    async listSetupAttempts(
      sessionId: string,
      filter?: { readonly runtimeId?: string; readonly generation?: number },
    ): Promise<readonly SetupAttemptRecord[]> {
      const rows = await runner.select<SetupAttemptRow>(setupAttempts, {
        where: allOf([
          eq(setupAttempts.sessionId, sessionId),
          filter?.runtimeId !== undefined
            ? eq(setupAttempts.runtimeId, filter.runtimeId)
            : undefined,
          filter?.generation !== undefined
            ? eq(setupAttempts.generation, filter.generation)
            : undefined,
        ]),
        orderBy: [asc(setupAttempts.startedAt), asc(setupAttempts.executionId)],
      });
      return rows.map(toSetupAttemptRecord);
    },

    // ── Job-status stream ────────────────────────────────────────
    async appendJobStatus(record: JobStatusRecord): Promise<boolean> {
      const inserted = await runner.insertIgnoreReturningCount(
        jobStatus,
        values.jobStatusInsert(record),
        // Conflict target = the full composite unique index columns.
        [
          jobStatus.sessionId,
          jobStatus.progressScopeId,
          jobStatus.pluginId,
          jobStatus.runtimeId,
          jobStatus.jobId,
          jobStatus.sequence,
        ],
      );
      return inserted === 1;
    },

    async listJobStatus(
      sessionId: string,
      filter?: { readonly progressScopeId?: string; readonly jobId?: string },
    ): Promise<readonly JobStatusRecord[]> {
      const rows = await runner.select<JobStatusRow>(jobStatus, {
        where: allOf([
          eq(jobStatus.sessionId, sessionId),
          filter?.progressScopeId !== undefined
            ? eq(jobStatus.progressScopeId, filter.progressScopeId)
            : undefined,
          filter?.jobId !== undefined
            ? eq(jobStatus.jobId, filter.jobId)
            : undefined,
        ]),
        orderBy: [asc(jobStatus.jobId), asc(jobStatus.sequence)],
      });
      return rows.map((row) => toJobStatusRecord(row, json));
    },
  };
}
