/**
 * Backend-agnostic canonical row→record mappers for the scheduling-redesign
 * lifecycle domain (logical-turn ledger, setup attempts, job status).
 *
 * Column names already match the camelCase record fields. Optional columns are
 * collapsed with a conditional spread (`null` → absent) so every backend
 * round-trips an absent optional as absent — the same parity discipline the
 * session mapper follows. Only `job_status.data` is a JSON column and flows
 * through the injected {@link JsonReader}.
 */

import type {
  JobStatusRecord,
  JobStatusState,
  LogicalTurnLedgerRecord,
  SetupAttemptRecord,
  SetupAttemptState,
} from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface LogicalTurnLedgerRow {
  sessionId: string;
  logicalTurnId: string;
  completedByExecutionId: string;
  completedAt: string;
}

export function toLogicalTurnLedgerRecord(
  row: LogicalTurnLedgerRow,
): LogicalTurnLedgerRecord {
  return {
    sessionId: row.sessionId,
    logicalTurnId: row.logicalTurnId,
    completedByExecutionId: row.completedByExecutionId,
    completedAt: row.completedAt,
  };
}

export interface SetupAttemptRow {
  sessionId: string;
  runtimeId: string;
  pluginVersion: string;
  generation: number;
  executionId: string;
  state: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export function toSetupAttemptRecord(row: SetupAttemptRow): SetupAttemptRecord {
  return {
    sessionId: row.sessionId,
    runtimeId: row.runtimeId,
    pluginVersion: row.pluginVersion,
    generation: row.generation,
    executionId: row.executionId,
    state: row.state as SetupAttemptState,
    startedAt: row.startedAt,
    ...(row.finishedAt != null ? { finishedAt: row.finishedAt } : {}),
    ...(row.error != null ? { error: row.error } : {}),
  };
}

/**
 * Canonicalise a setup-attempt record: collapse `finishedAt`/`error` to
 * absent-when-null. The non-SQL backends (Memory / IDB) store records directly,
 * so they call this on write to match the SQL read-side collapse (nullable
 * columns → absent). Keeping the rule here — beside {@link toSetupAttemptRecord}
 * which enforces the same on the SQL read path — is the single source of truth.
 */
export function canonicalSetupAttempt(
  r: SetupAttemptRecord,
): SetupAttemptRecord {
  return {
    sessionId: r.sessionId,
    runtimeId: r.runtimeId,
    pluginVersion: r.pluginVersion,
    generation: r.generation,
    executionId: r.executionId,
    state: r.state,
    startedAt: r.startedAt,
    ...(r.finishedAt != null ? { finishedAt: r.finishedAt } : {}),
    ...(r.error != null ? { error: r.error } : {}),
  };
}

/**
 * Canonicalise a job-status record: collapse `progress`/`message`/`data` to
 * absent-when-null (parity with the SQL nullable columns; see
 * {@link toJobStatusRecord}). `data != null` keeps falsy-but-valid JSON values
 * (`false` / `0` / `""`) and strips only `null` / `undefined`.
 */
export function canonicalJobStatus(r: JobStatusRecord): JobStatusRecord {
  return {
    sessionId: r.sessionId,
    progressScopeId: r.progressScopeId,
    pluginId: r.pluginId,
    runtimeId: r.runtimeId,
    jobId: r.jobId,
    state: r.state,
    ...(r.progress != null ? { progress: r.progress } : {}),
    ...(r.message != null ? { message: r.message } : {}),
    ...(r.data != null ? { data: r.data } : {}),
    sequence: r.sequence,
    createdAt: r.createdAt,
  };
}

export interface JobStatusRow {
  sessionId: string;
  progressScopeId: string;
  pluginId: string;
  runtimeId: string;
  jobId: string;
  state: string;
  progress: number | null;
  message: string | null;
  data: unknown;
  sequence: number;
  createdAt: string;
}

export function toJobStatusRecord(
  row: JobStatusRow,
  json: JsonReader,
): JobStatusRecord {
  const data = json.read(row.data);
  return {
    sessionId: row.sessionId,
    progressScopeId: row.progressScopeId,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    jobId: row.jobId,
    state: row.state as JobStatusState,
    ...(row.progress != null ? { progress: row.progress } : {}),
    ...(row.message != null ? { message: row.message } : {}),
    ...(data !== undefined ? { data: data as JobStatusRecord["data"] } : {}),
    sequence: row.sequence,
    createdAt: row.createdAt,
  };
}
