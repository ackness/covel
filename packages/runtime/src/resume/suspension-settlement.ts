/**
 * The exits of a suspension other than a successful resume.
 *
 * A suspended player turn holds back its turn-level work: the turn is counted
 * and its detached jobs are queued only by the resume that ends the turn. A
 * suspension can also end by being abandoned (`DELETE`), by expiring (the TTL
 * sweep), or by being voided because it is out of date. Every exit settles
 * the same way: when it was the last pending suspension of its logical turn,
 * the turn counts and its held-back jobs are queued, as after a normal end;
 * the progress jobs the suspended execution reported end `cancelled`.
 *
 * The host owns the session lock and the transaction; queuing the released
 * jobs is the host's (`enqueueDeferredRuntimeJobs` in the server).
 */

import type {
  DeferredRuntimeJob,
  ExecutionContext,
  RuntimeManifest,
} from "@covel/shared";
import {
  isBudgetedAttempt,
  resolvePendingOrBlocked,
  setupRetryBudget,
} from "@covel/shared";
import type {
  DataStore,
  StoreTransaction,
  SuspensionBasis,
  SuspensionRecord,
} from "@covel/store";
import type { EventBus } from "@covel/events";
import {
  applySessionClockTx,
  updateSetupRuntimeStates,
} from "../commit/session-clock.js";
import { finalizeSuspendedJobStatuses } from "../job-status/job-status.js";
import {
  changedSuspensionWrites,
  type SuspensionWriteReader,
} from "./suspension-baseline.js";

/**
 * Whether a suspension still waits for an answer: unresolved, or claimed by a
 * resume that has not committed. A claim is released when that resume fails,
 * so a claimed sibling still owes its turn an ending.
 */
export function isPendingSuspension(record: SuspensionRecord): boolean {
  return (
    record.resolvedAt === undefined || record.resolvedAt.startsWith("claimed:")
  );
}

/** Whether another suspension of the same logical turn still waits. */
export function hasPendingSibling(
  suspension: SuspensionRecord,
  all: readonly SuspensionRecord[],
): boolean {
  const logicalTurnId =
    suspension.pendingContinuation.executionContext.logicalTurnId;
  if (!logicalTurnId) return false;
  return all.some(
    (candidate) =>
      candidate.id !== suspension.id &&
      isPendingSuspension(candidate) &&
      candidate.pendingContinuation.executionContext.logicalTurnId ===
        logicalTurnId,
  );
}

/** The version recorded for a plugin that declares none. */
export function suspensionPluginVersion(manifest: RuntimeManifest): string {
  return manifest.version ?? "0.0.0";
}

/** Player turns in the session's history: its player messages. */
export async function countPlayerTurns(
  store: Pick<DataStore, "getTurnMessageStats">,
  sessionId: string,
): Promise<number> {
  return (await store.getTurnMessageStats(sessionId)).playerMessageCount;
}

/**
 * The basis a runtime records when it suspends. The commit that saves the
 * suspension fills in the player turns (`executeTurn`) and the records its
 * buffered proposals write (`finalizeExecution`).
 */
export function suspensionBasis(
  manifest: RuntimeManifest,
  playerTurns: number,
): SuspensionBasis {
  return {
    playerTurns,
    pluginVersion: suspensionPluginVersion(manifest),
    writes: [],
  };
}

/**
 * Why a suspension can no longer be resumed, or `undefined` when it can:
 * - `plugin-updated`: the plugin that owns the runtime changed version, so the
 *   saved transcript and buffered writes belong to another version;
 * - `session-moved-on`: the player's history changed since the suspension
 *   (a later player turn, or a rewind), so its buffered writes could
 *   overwrite newer state;
 * - `data-changed`: a record its buffered proposals write was changed since
 *   (by a background job or a manual run, for example); committing them would
 *   put back what the runtime saw when it stopped.
 *
 * A runtime never has two pending suspensions: saving a new one voids the
 * older one in the same transaction (`finalizeExecution`).
 */
export type SuspensionOutdatedReason =
  "plugin-updated" | "session-moved-on" | "data-changed";

export async function suspensionOutdatedReason(
  store: Pick<DataStore, "getTurnMessageStats"> & SuspensionWriteReader,
  suspension: SuspensionRecord,
  manifest: RuntimeManifest,
): Promise<SuspensionOutdatedReason | undefined> {
  const basis = suspension.pendingContinuation.takenUnder;
  if (basis.pluginVersion !== suspensionPluginVersion(manifest))
    return "plugin-updated";
  if (
    (await countPlayerTurns(store, suspension.sessionId)) !== basis.playerTurns
  )
    return "session-moved-on";
  const changed = await changedSuspensionWrites(
    store,
    suspension.sessionId,
    basis.writes,
  );
  return changed.length > 0 ? "data-changed" : undefined;
}

/** What abandoning one suspension settles. */
export interface SuspensionAbandonPlan {
  readonly suspension: SuspensionRecord;
  /** The suspension was the last pending one of its turn: the turn ends with it. */
  readonly endsTurn: boolean;
  /** Counts the player turn (only when it ends the turn and was to count). */
  readonly countsPlayerTurn: boolean;
  /** Detached jobs the turn held back, to queue in the same transaction. */
  readonly releasedRuntimeJobs: readonly DeferredRuntimeJob[];
}

/** Read under the session lock, before the transaction. */
export async function planSuspensionAbandon(
  store: Pick<DataStore, "listSuspensions">,
  suspension: SuspensionRecord,
): Promise<SuspensionAbandonPlan> {
  // A resolved record has no turn left to settle: deleting it is all.
  if (!isPendingSuspension(suspension)) {
    return {
      suspension,
      endsTurn: false,
      countsPlayerTurn: false,
      releasedRuntimeJobs: [],
    };
  }
  const endsTurn = !hasPendingSibling(
    suspension,
    await store.listSuspensions(suspension.sessionId),
  );
  const continuation = suspension.pendingContinuation;
  return {
    suspension,
    endsTurn,
    countsPlayerTurn:
      endsTurn &&
      continuation.executionContext.countPolicy === "complete-player-turn",
    releasedRuntimeJobs: endsTurn
      ? ((continuation.withheldRuntimeJobs ??
          []) as readonly DeferredRuntimeJob[])
      : [],
  };
}

/**
 * The durable half: delete the record and, when it ends its turn, count the
 * turn. Queue `plan.releasedRuntimeJobs` in the same transaction. Counting is
 * idempotent per logical turn, so a retried abandon never counts twice.
 */
export async function applySuspensionAbandonTx(
  tx: StoreTransaction,
  plan: SuspensionAbandonPlan,
  now: string,
): Promise<void> {
  const { suspension } = plan;
  await tx.deleteSuspension(suspension.id);
  if (!plan.countsPlayerTurn) return;
  const executionContext: ExecutionContext =
    suspension.pendingContinuation.executionContext;
  await applySessionClockTx(tx, {
    sessionId: suspension.sessionId,
    executionContext,
    update: { now },
  });
}

/** The error a setup attempt ends with when its suspension ends unanswered. */
export const ABANDONED_SETUP_ATTEMPT_ERROR =
  "The suspension ended without an answer";

/**
 * A suspended setup runtime holds its attempt open (`suspended`, which spends
 * none of the retry budget). When the suspension ends without a resume, the
 * attempt ends `failed` and the runtime's state is worked out again: pending,
 * or blocked once that attempt used up its budget (never while a newer
 * suspension of the runtime still waits). The runtime stays not done,
 * so the next turn runs it again, or the player retries or skips it, as after
 * any failed attempt. A runtime that is not a setup runtime, or whose attempt
 * already ended, is left alone.
 *
 * `manifest` is the runtime's active manifest, for its retry budget; without
 * one the budget is unbounded. Like every setup-attempt write, this runs after
 * the transaction that removed the suspension.
 */
export async function settleAbandonedSetupAttempt(
  store: Pick<
    DataStore,
    "listSetupAttempts" | "updateSetupAttempt" | "getSession" | "updateSession"
  >,
  suspension: SuspensionRecord,
  manifest: RuntimeManifest | undefined,
  now: string,
): Promise<void> {
  const { sessionId, runtimeId } = suspension;
  const executionId =
    suspension.pendingContinuation.executionContext.executionId;
  const attempt = (
    await store.listSetupAttempts(sessionId, { runtimeId })
  ).find(
    (candidate) =>
      candidate.executionId === executionId && candidate.state === "suspended",
  );
  if (!attempt) return;
  await store.updateSetupAttempt(
    sessionId,
    runtimeId,
    attempt.generation,
    executionId,
    { state: "failed", finishedAt: now, error: ABANDONED_SETUP_ATTEMPT_ERROR },
  );
  const generation = await store.listSetupAttempts(sessionId, {
    runtimeId,
    generation: attempt.generation,
  });
  const spent = generation.filter((candidate) =>
    isBudgetedAttempt(candidate.state),
  ).length;
  // Another attempt has not ended: a newer suspension that replaced this one
  // and waits for the player, or the run that is saving it. The runtime is
  // not blocked under it; that attempt settles the runtime itself.
  const stillWaiting = generation.some(
    (candidate) =>
      candidate.state === "suspended" || candidate.state === "started",
  );
  await updateSetupRuntimeStates(store, sessionId, now, (current) => {
    const mirror = current[runtimeId];
    // Completed or skipped since, or already a later generation: keep it.
    if (!mirror || mirror.state === "done") return {};
    if (mirror.generation !== attempt.generation) return {};
    return {
      [runtimeId]: resolvePendingOrBlocked({
        attempts: spent,
        budget:
          manifest && !stillWaiting ? setupRetryBudget(manifest) : undefined,
        pluginVersion: attempt.pluginVersion,
        generation: attempt.generation,
        now,
        lastError: ABANDONED_SETUP_ATTEMPT_ERROR,
      }),
    };
  });
}

/** After the transaction commits: end the suspended execution's progress jobs. */
export async function settleAbandonedSuspensionJobs(
  deps: {
    readonly store: Pick<DataStore, "appendJobStatus" | "listJobStatus">;
    readonly eventBus?: EventBus;
  },
  suspension: SuspensionRecord,
): Promise<void> {
  await finalizeSuspendedJobStatuses(
    deps,
    {
      sessionId: suspension.sessionId,
      executionId: suspension.pendingContinuation.executionContext.executionId,
      pluginId: suspension.pluginId,
      runtimeId: suspension.runtimeId,
    },
    "skipped",
  );
}
