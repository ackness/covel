/**
 * Setup-runtime attempt ledger settlement — runs OUTSIDE the finalize
 * transaction.
 *
 * For every setup runtime that ran in an execution, this terminalises its
 * ledger attempt, recomputes the real terminal-attempt count, and reconciles
 * the session mirror. It runs after the domain commit outcome is known,
 * deliberately outside the transaction: a rolled-back commit still burns an
 * attempt, so a deterministic failure eventually exhausts the retry budget
 * and lands on `blocked` instead of retrying forever. The finalize transaction
 * still owns the atomic done signal and phase flip; this settlement replaces
 * its provisional attempt count with the authoritative ledger total.
 *
 * Idempotency: the ledger is keyed on `(sessionId, runtimeId, generation,
 * executionId)`. Each execution carries a unique executionId, so re-running
 * settle for the same execution terminalises the same row (a no-op update).
 */

import type { DataStore } from "@covel/store";
import type {
  RanSetupRuntime,
  SetupAttemptState,
  SetupRuntimeState,
} from "@covel/shared";
import {
  isBudgetedAttempt,
  mirrorSetupDone,
  resolvePendingOrBlocked,
} from "@covel/shared";

export type { RanSetupRuntime } from "@covel/shared";

export async function settleSetupRuntimes(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly ran: readonly RanSetupRuntime[];
  readonly committed: boolean;
  readonly now: string;
}): Promise<void> {
  const { store, sessionId, ran, committed, now } = args;
  if (ran.length === 0) return;

  for (const r of ran) {
    // A done-signalled attempt whose proposals rolled back counts as failed —
    // that is precisely how a deterministic commit failure depletes the budget.
    const rolledBackDone = r.doneSignal && !committed;
    const ledgerState: SetupAttemptState = rolledBackDone
      ? "failed"
      : r.ledgerState;
    const error = rolledBackDone
      ? (r.error ?? "proposal commit rolled back")
      : r.error;
    // Guarantee the row exists (crash before the in-flight `started` insert) —
    // insert is a no-op when executeOneRuntime already recorded it — then
    // terminalise it. The ledger write lives outside any transaction on
    // purpose; a rolled-back commit must not un-burn the attempt.
    await store.insertSetupAttempt({
      sessionId,
      runtimeId: r.runtimeId,
      pluginVersion: r.pluginVersion,
      generation: r.generation,
      executionId: r.executionId,
      state: "started",
      startedAt: r.startedAt,
    });
    await store.updateSetupAttempt(
      sessionId,
      r.runtimeId,
      r.generation,
      r.executionId,
      { state: ledgerState, finishedAt: now, ...(error ? { error } : {}) },
    );
  }

  const session = await store.getSession(sessionId);
  if (!session) return;
  const mirror: Record<string, SetupRuntimeState> = {
    ...session.setupRuntimes,
  };
  let changed = false;
  for (const r of ran) {
    const terminal = (
      await store.listSetupAttempts(sessionId, {
        runtimeId: r.runtimeId,
        generation: r.generation,
      })
    ).filter((a) => isBudgetedAttempt(a.state)).length;
    if (r.doneSignal && committed) {
      const current = session.setupRuntimes[r.runtimeId];
      mirror[r.runtimeId] = mirrorSetupDone(
        r.pluginVersion,
        current?.state === "done" ? current.completedAt : now,
        r.generation,
        terminal,
      );
    } else {
      mirror[r.runtimeId] = resolvePendingOrBlocked({
        attempts: terminal,
        budget: r.budget,
        pluginVersion: r.pluginVersion,
        generation: r.generation,
        now,
        ...(r.error ? { lastError: r.error } : {}),
      });
    }
    changed = true;
  }
  if (!changed) return;

  await store.updateSession(sessionId, {
    setupRuntimes: mirror,
    updatedAt: now,
  });
}
