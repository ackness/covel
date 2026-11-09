/**
 * Saving an execution's continuations inside its commit transaction.
 *
 * A saved continuation records what its buffered proposals would overwrite
 * (`takenUnder.writes`), read after this execution's own writes, and holds
 * back the detached jobs of its turn for the resume. A runtime has one pending
 * suspension: saving one voids every other pending suspension of the same
 * runtime, settled like an abandon. A continuation whose run was dropped at
 * commit is never saved; when none of the execution's continuations survives,
 * its turn ends here as if they had been abandoned.
 */

import type { StoreTransaction, SuspensionRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { DeferredRuntimeJob } from "@covel/shared";
import {
  nestedResultProposals,
  takeSuspensionWriteBaseline,
} from "../resume/suspension-baseline.js";
import {
  applySuspensionAbandonTx,
  isPendingSuspension,
  planSuspensionAbandon,
  settleAbandonedSetupAttempt,
  settleAbandonedSuspensionJobs,
} from "../resume/suspension-settlement.js";
import { finalizePresentationJobs } from "../presentation/jobs.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { applySessionClockTx } from "./session-clock.js";
import type { FinalizeExecutionArgs } from "./finalize-types.js";

/** What saving the continuations reads from the execution being finalized. */
export type SuspensionCommitArgs = Pick<
  FinalizeExecutionArgs,
  | "store"
  | "sessionId"
  | "runtimes"
  | "eventBus"
  | "sessionClock"
  | "suspensions"
  | "enqueueReleasedJobsInTx"
  | "onRuntimeCorrection"
>;

/** How the commit dropped runs bear on the continuations. */
export interface SuspensionDrops {
  /** Suspension ids whose run was dropped at commit. */
  readonly suspensionIds: ReadonlySet<string>;
  /** Held-back jobs as this execution committed them. */
  readonly settleJobs: (
    jobs: readonly DeferredRuntimeJob[],
  ) => readonly DeferredRuntimeJob[];
  /** Story messages nested runs wrote, left out of the turn's story. */
  readonly nestedStoryMessageIds?: ReadonlySet<string>;
}

function emitCommittedSuspension(
  eventBus: EventBus | undefined,
  suspension: SuspensionRecord,
): void {
  emitSubEvent(eventBus, "game", "turn.suspended", suspension.sessionId, {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    suspensionId: suspension.id,
    pluginId: suspension.pluginId,
    runtimeId: suspension.runtimeId,
    suspendedAt: suspension.createdAt,
    reason: suspension.reason,
    resumeSchema: suspension.resumeSchema,
  });
}

export async function saveSuspensions(
  tx: StoreTransaction,
  args: SuspensionCommitArgs,
  deferPostCommit: (fn: () => Promise<void>) => void,
  dropped: SuspensionDrops,
): Promise<void> {
  const { store, sessionId, runtimes, eventBus, sessionClock } = args;
  const saved = new Map<string, SuspensionRecord>();
  const voided: SuspensionRecord[] = [];
  const now = sessionClock?.now ?? new Date().toISOString();
  const suspensions = args.suspensions ?? [];
  for (const suspension of suspensions) {
    if (suspension.sessionId !== sessionId) {
      throw new Error(
        `suspension ${suspension.id} belongs to session ${suspension.sessionId}, expected ${sessionId}`,
      );
    }
    // The run that asked for input had its writes dropped: nothing may
    // resume it, and it must not replace a suspension that still stands.
    if (dropped.suspensionIds.has(suspension.id)) continue;
    // What the buffered proposals would overwrite, read after this
    // execution's own writes: a resume compares it before committing.
    const continuation = suspension.pendingContinuation;
    const record: SuspensionRecord = {
      ...suspension,
      pendingContinuation: {
        ...continuation,
        // The jobs it holds back for the resume see this commit's drops
        // the way the host's own deferred jobs do.
        ...(continuation.withheldRuntimeJobs
          ? {
              withheldRuntimeJobs: await finalizePresentationJobs(
                tx,
                sessionId,
                dropped.settleJobs(
                  continuation.withheldRuntimeJobs as readonly DeferredRuntimeJob[],
                ),
                runtimes,
                false,
                dropped.nestedStoryMessageIds,
              ),
            }
          : {}),
        takenUnder: {
          ...continuation.takenUnder,
          writes: await takeSuspensionWriteBaseline(tx, sessionId, [
            ...continuation.pendingProposals,
            ...nestedResultProposals(
              continuation.nestedResults ?? [],
              sessionId,
            ),
          ]),
        },
      },
    };
    await tx.saveSuspension(record);
    saved.set(record.id, record);
    // One pending suspension per runtime: the new one replaces the rest,
    // which end as if abandoned (their turn may count and release jobs).
    for (const older of await tx.listSuspensions(sessionId)) {
      if (
        older.id === record.id ||
        older.runtimeId !== record.runtimeId ||
        !isPendingSuspension(older)
      )
        continue;
      const plan = await planSuspensionAbandon(tx, older);
      await applySuspensionAbandonTx(tx, plan, now);
      if (plan.releasedRuntimeJobs.length > 0) {
        if (!args.enqueueReleasedJobsInTx) {
          throw new Error(
            `cannot queue the jobs held back by replaced suspension ${older.id}`,
          );
        }
        await args.enqueueReleasedJobsInTx(tx, plan.releasedRuntimeJobs);
      }
      saved.delete(older.id);
      voided.push(older);
    }
  }
  // When every continuation of this execution was dropped, its turn ends
  // here as if they had been abandoned: it counts, and the jobs it held
  // back for the resume are queued now.
  const abandoned = suspensions.filter((suspension) =>
    dropped.suspensionIds.has(suspension.id),
  );
  if (abandoned.length > 0 && abandoned.length === suspensions.length) {
    const continuation = abandoned[0]!.pendingContinuation;
    if (continuation.executionContext.countPolicy === "complete-player-turn") {
      await applySessionClockTx(tx, {
        sessionId,
        executionContext: continuation.executionContext,
        update: { now },
      });
    }
    const jobs = dropped.settleJobs(
      (continuation.withheldRuntimeJobs ?? []) as readonly DeferredRuntimeJob[],
    );
    if (jobs.length > 0) {
      if (!args.enqueueReleasedJobsInTx) {
        throw new Error(
          `cannot queue the jobs held back by dropped suspension ${abandoned[0]!.id}`,
        );
      }
      await args.enqueueReleasedJobsInTx(tx, jobs);
    }
  }
  for (const record of saved.values()) {
    deferPostCommit(async () => {
      emitCommittedSuspension(eventBus, record);
    });
  }
  for (const older of voided) {
    deferPostCommit(async () => {
      await settleAbandonedSuspensionJobs(
        {
          store,
          ...(eventBus ? { eventBus } : {}),
          onRuntimeCorrection: args.onRuntimeCorrection,
        },
        older,
      );
      await settleAbandonedSetupAttempt(
        store,
        older,
        runtimes.find((runtime) => runtime.name === older.runtimeId),
        now,
      );
    });
  }
}
