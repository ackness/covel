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
import type {
  DataStore,
  StoreTransaction,
  SuspensionBasis,
  SuspensionRecord,
} from "@covel/store";
import type { EventBus } from "@covel/events";
import { applySessionClockTx } from "../commit/session-clock.js";
import { finalizeSuspendedJobStatuses } from "../job-status/job-status.js";

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

export function suspensionBasis(
  manifest: RuntimeManifest,
  playerTurns: number,
): SuspensionBasis {
  return { playerTurns, pluginVersion: suspensionPluginVersion(manifest) };
}

/**
 * Why a suspension can no longer be resumed, or `undefined` when it can:
 * - `plugin-updated`: the plugin that owns the runtime changed version, so the
 *   saved transcript and buffered writes belong to another version;
 * - `session-moved-on`: the player's history changed since the suspension
 *   (a later player turn, or a rewind), so its buffered writes could
 *   overwrite newer state;
 * - `superseded`: the same runtime suspended again later; a runtime has one
 *   suspension that can be resumed.
 */
export type SuspensionOutdatedReason =
  "plugin-updated" | "session-moved-on" | "superseded";

export async function suspensionOutdatedReason(
  store: Pick<DataStore, "getTurnMessageStats" | "listSuspensions">,
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
  const later = (await store.listSuspensions(suspension.sessionId)).some(
    (other) =>
      other.id !== suspension.id &&
      other.runtimeId === suspension.runtimeId &&
      other.createdAt > suspension.createdAt,
  );
  return later ? "superseded" : undefined;
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
