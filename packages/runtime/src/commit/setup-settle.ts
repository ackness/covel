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
import { updateSetupRuntimeStates } from "./session-clock.js";

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

  // Terminal-attempt totals come from the ledger written above.
  const terminalAttempts = new Map<string, number>();
  for (const r of ran) {
    const attempts = await store.listSetupAttempts(sessionId, {
      runtimeId: r.runtimeId,
      generation: r.generation,
    });
    terminalAttempts.set(
      r.runtimeId,
      attempts.filter((a) => isBudgetedAttempt(a.state)).length,
    );
  }

  await updateSetupRuntimeStates(store, sessionId, now, (current) => {
    const entries: Record<string, SetupRuntimeState> = {};
    for (const r of ran) {
      const lastError =
        r.doneSignal && !committed
          ? (r.error ?? "proposal commit rolled back")
          : r.error;
      const terminal = terminalAttempts.get(r.runtimeId) ?? 0;
      if (r.doneSignal && committed) {
        const previous = current[r.runtimeId];
        entries[r.runtimeId] = mirrorSetupDone(
          r.pluginVersion,
          previous?.state === "done" ? previous.completedAt : now,
          r.generation,
          terminal,
        );
      } else {
        entries[r.runtimeId] = resolvePendingOrBlocked({
          attempts: terminal,
          budget: r.budget,
          pluginVersion: r.pluginVersion,
          generation: r.generation,
          now,
          ...(lastError ? { lastError } : {}),
        });
      }
    }
    return entries;
  });
}
