/**
 * Session-lifecycle contract types for the runtime-scheduling redesign.
 *
 * These are pure persistence-facing shapes shared by the store layer and the
 * (future) kernel wiring. This file only declares the contract; no kernel logic
 * reads or writes these yet. Three concerns live here:
 *
 *  - Setup-band progress: per-runtime `SetupRuntimeState` (mirrored onto the
 *    session row) plus an append-mostly `SetupAttemptRecord` audit log.
 *  - Logical-turn idempotency: `LogicalTurnLedgerRecord` records "this logical
 *    turn was already completed", so a retried/duplicated execution counts the
 *    turn at most once.
 *  - Background job progress: append-only `JobStatusRecord` stream.
 *
 * All fields are `readonly` — records are immutable snapshots; a state change
 * produces a new record (or, for the setup attempt log, a terminalising patch).
 */

import type { JsonValue } from "./runtime-scheduling.js";

// ── Setup-band runtime state ─────────────────────────────────────

/**
 * The resolution state of one setup-band runtime for a session, mirrored onto
 * `SessionRecord.setupRuntimes` (keyed by runtimeId).
 *
 * `generation` bumps when the plugin set / plugin version changes, so a stale
 * `done` from a previous generation does not suppress a re-run. `attempts` is a
 * monotonic counter over `SetupAttemptRecord`s for the current generation.
 *
 *  - `pending`  — not yet resolved this generation; may carry the `lastError`
 *                 of the most recent failed attempt.
 *  - `done`     — resolved, either `completed` (ran to success) or `waived`
 *                 (skipped by policy); `warning` carries a non-fatal note.
 *  - `blocked`  — cannot proceed (e.g. exhausted retries / hard dependency
 *                 failure); `reason` explains why.
 */
export type SetupRuntimeState =
  | {
      readonly state: "pending";
      readonly pluginVersion: string;
      readonly generation: number;
      readonly attempts: number;
      readonly lastError?: string;
    }
  | {
      readonly state: "done";
      readonly resolution: "completed" | "waived";
      readonly generation: number;
      readonly attempts: number;
      readonly completedAt: string;
      readonly pluginVersion: string;
      readonly warning?: string;
    }
  | {
      readonly state: "blocked";
      readonly pluginVersion: string;
      readonly generation: number;
      readonly attempts: number;
      readonly reason: string;
      readonly blockedAt: string;
    };

/** Lifecycle state of a single setup-runtime attempt. */
export type SetupAttemptState =
  "started" | "success" | "failed" | "skipped" | "suspended";

/**
 * One setup-runtime execution attempt (audit log behind `setupRuntimes`).
 *
 * Uniqueness / idempotency key: `(sessionId, runtimeId, generation,
 * executionId)`. A re-insert of the same key is a no-op (the first write wins);
 * the attempt is later terminalised in place (`state` → success/failed/…,
 * `finishedAt`, `error`).
 */
export interface SetupAttemptRecord {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly pluginVersion: string;
  readonly generation: number;
  readonly executionId: string;
  readonly state: SetupAttemptState;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

// ── Logical-turn completion ledger ───────────────────────────────

/**
 * Records that a logical turn has been completed, exactly once.
 *
 * Primary key `(sessionId, logicalTurnId)` is the idempotency guarantee: the
 * first writer wins and every later insert for the same logical turn is
 * rejected (no-op), so the turn is counted at most once even under retries,
 * duplicated events, or cross-pod races. `completedByExecutionId` records which
 * execution actually claimed the completion.
 */
export interface LogicalTurnLedgerRecord {
  readonly sessionId: string;
  readonly logicalTurnId: string;
  readonly completedByExecutionId: string;
  readonly completedAt: string;
}

// ── Background job progress ──────────────────────────────────────

/** Lifecycle state of a background job progress event. */
export type JobStatusState =
  | "queued"
  | "running"
  | "progress"
  | "waiting-input"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * One append-only progress event for a background job.
 *
 * The stream is append-only and idempotent on `(sessionId, progressScopeId,
 * pluginId, runtimeId, jobId, sequence)`: `sequence` is a per-job monotonic
 * counter, a duplicate `(jobId, sequence)` is rejected (the earlier event
 * wins), and consumers read events for a job ordered by `sequence` ascending.
 * `data` carries an optional structured payload (JSON wire value only).
 */
export interface JobStatusRecord {
  readonly sessionId: string;
  readonly progressScopeId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly jobId: string;
  readonly state: JobStatusState;
  readonly progress?: number;
  readonly message?: string;
  readonly data?: JsonValue;
  readonly sequence: number;
  readonly createdAt: string;
}
