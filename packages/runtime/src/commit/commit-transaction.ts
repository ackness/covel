/**
 * The body of `finalizeExecution`'s single transaction: an ordered list of
 * named steps over one shared context. The order is part of the contract,
 * and each step's comment says why it sits where it does.
 */

import type { StoreTransaction } from "@covel/store";
import type { SessionEvent } from "@covel/shared";
import { assertSuspensionWritesUnchanged } from "../resume/suspension-baseline.js";
import { storyOutputError } from "../agent-loop/story-output.js";
import {
  HOOK_FAILURE_SKIP,
  failedUpstreamOf,
  skippedByOf,
} from "../turn-executor/turn-executor-helpers.js";
import { recordRuntimeTriggersTx } from "../trigger/trigger-ledger.js";
import {
  bindDimensionProvider,
  type DimensionSettlementScope,
} from "./dimension-finalization.js";
import { droppedUpstream, settleDroppedInputs } from "./commit-dependencies.js";
import { applySessionClockTx } from "./session-clock.js";
import { saveSuspensions } from "./suspension-commit.js";
import {
  publishCommittedExports,
  type ExportDecl,
} from "./runtime-export-publish.js";
import { settlementsOf } from "./operation-ledger.js";
import {
  commitUnitsInOrder,
  registerSettlements,
  type UnitCommitContext,
} from "./commit-units.js";

/** The context every step reads and fills. */
export interface CommitTxContext extends UnitCommitContext {
  /** Set by `bindSettlementScope`, before any unit commits. */
  dimensions: DimensionSettlementScope | undefined;
  readonly exportDecls: ReadonlyMap<string, ExportDecl>;
  /** Whether the session clock is written (`needsSessionClockWrite`). */
  readonly shouldWriteClock: boolean;
}

/** What the finalize hands the transaction; the rest is per transaction. */
export type CommitRun = Omit<
  CommitTxContext,
  "tx" | "events" | "narrativeOwners" | "dimensions" | "scopedRetry"
>;

type CommitStep = (ctx: CommitTxContext) => Promise<void> | void;

/** The transaction body, in order. A throw from any step rolls back. */
const COMMIT_STEPS: readonly CommitStep[] = [
  throwIfAborted,
  checkWriteBaseline,
  rejectUncommittableStory,
  bindSettlementScope,
  commitUnitsInOrder,
  settleNarratives,
  appendJournal,
  runHostWrites,
  throwIfAborted,
  saveContinuations,
  writeSessionClock,
  recordTriggers,
  publishExports,
  settleCommitStatus,
  throwIfAborted,
];

/** Run every step in `tx`; returns the events of the committed proposals. */
export async function runCommitTransaction(
  tx: StoreTransaction,
  run: CommitRun,
): Promise<readonly SessionEvent[]> {
  const { executionContext } = run.args;
  const ctx: CommitTxContext = {
    ...run,
    tx,
    events: [],
    narrativeOwners: new Map(),
    dimensions: undefined,
    scopedRetry:
      executionContext.origin === "manual" &&
      executionContext.sourceTurnId !== undefined,
  };
  for (const step of COMMIT_STEPS) await step(ctx);
  return ctx.events;
}

function throwIfAborted(ctx: CommitTxContext): void {
  ctx.args.signal?.throwIfAborted();
}

async function checkWriteBaseline(ctx: CommitTxContext): Promise<void> {
  // A resume must not put back what a later write replaced: compare the
  // records its buffered proposals write before anything is written.
  await assertSuspensionWritesUnchanged(
    ctx.tx,
    ctx.args.sessionId,
    ctx.args.writeBaseline ?? [],
  );
}

function rejectUncommittableStory(ctx: CommitTxContext): void {
  // A failed story cannot complete a player action. Optional state
  // extractors, the dimension provider among them, may fail independently
  // after a valid narrative exists.
  const stories = ctx.args.results.filter(
    (result) => ctx.options.kindOf(result) === "story",
  );
  for (const result of stories) {
    const error =
      result.status === "failed"
        ? `Story runtime ${result.runtimeId} failed; the action was not committed.`
        : result.status === "success"
          ? storyOutputError(result.output)
          : undefined;
    if (error) throw new Error(error);
  }
  // So is a story the `needs` or required-input gate held back because a
  // runtime it hard depends on failed in this execution, or was skipped by a
  // failed hook: the gate records that runtime as `failedUpstream`. So is a
  // story skipped because a PreRuntime handler failed judging it. Unlike a
  // failed story it wrote nothing, so a narrative from another story still
  // completes the action.
  // Other held-back stories commit as before, and no gate records a failure
  // for them:
  // - an upstream its package chose not to run (trigger, cadence or guard):
  //   rejecting would stop the clock a cadence-gated upstream waits on;
  // - the plugin's pending setup: rejecting would discard the setup's own
  //   writes, such as its form;
  // - a dependency cycle, which also holds back everything after it, so a
  //   cycle in any package would stop every turn; validation and traces
  //   report it.
  if (stories.some((result) => result.status === "success")) return;
  for (const result of stories) {
    const failed = failedUpstreamOf(result);
    const error = failed
      ? `Story runtime ${result.runtimeId} did not run because ${failed} failed; the action was not committed.`
      : skippedByOf(result) === HOOK_FAILURE_SKIP.by
        ? `Story runtime ${result.runtimeId} did not run because a hook failed; the action was not committed.`
        : undefined;
    if (error) throw new Error(error);
  }
}

async function bindSettlementScope(ctx: CommitTxContext): Promise<void> {
  const { args } = ctx;
  ctx.dimensions = await bindDimensionProvider({
    logicalTurn: args.executionContext.logicalTurn,
    tx: ctx.tx,
    sessionId: args.sessionId,
    runtimes: args.runtimes,
  });
}

async function settleNarratives(ctx: CommitTxContext): Promise<void> {
  // Every narrative owes a settlement, whether or not a runtime of this
  // execution asked for its receipt.
  ctx.events.push(
    ...(await registerSettlements(ctx, ctx.tx, (fn) =>
      ctx.postCommit.push(fn),
    )),
  );
}

async function appendJournal(ctx: CommitTxContext): Promise<void> {
  const { args } = ctx;
  const { runDropped } = ctx.drops.settled();
  // A dropped runtime settles as failed: like any failed run, it adds
  // nothing to the conversation and does not count as a trigger.
  for (const message of args.journalMessages ?? []) {
    if (
      runDropped(args.journalMessageRuns?.[message.id], message.sourceRuntimeId)
    )
      continue;
    await ctx.tx.appendTurnMessage(message);
  }
}

async function runHostWrites(ctx: CommitTxContext): Promise<void> {
  const { extraInTx } = ctx.args;
  await extraInTx?.(ctx.tx, {
    droppedRuntimeIds: ctx.drops.settled().rootIds,
    droppedRunIds: ctx.drops.settled().runIds,
    followerSources: ctx.args.eventDependencies?.followers ?? [],
  });
}

async function saveContinuations(ctx: CommitTxContext): Promise<void> {
  const { args } = ctx;
  const { runtimes } = args;
  const { rootIds: droppedIds, runIds: droppedRunIds } = ctx.drops.settled();
  const manifestByRuntime = new Map(runtimes.map((rt) => [rt.name, rt]));
  const rootView = {
    runtimes,
    results: ctx.units.map((unit) => unit.root),
    dropped: droppedIds,
  };
  await saveSuspensions(ctx.tx, args, (fn) => ctx.postCommit.push(fn), {
    suspensionIds: new Set(
      (args.suspensions ?? [])
        .filter((suspension) => {
          const run = args.suspensionRuns?.[suspension.id];
          return run !== undefined && droppedRunIds.has(run);
        })
        .map((suspension) => suspension.id),
    ),
    // Like the host's own deferred jobs: none that builds on a dropped
    // runtime, and the rest see it as failed.
    settleJobs: (jobs) =>
      jobs
        .filter((job) => {
          const target = manifestByRuntime.get(job.runtimeId);
          return !target || !droppedUpstream(target, rootView);
        })
        .map((job) => settleDroppedInputs(job, droppedIds)),
  });
}

async function writeSessionClock(ctx: CommitTxContext): Promise<void> {
  const { args } = ctx;
  if (ctx.shouldWriteClock) {
    await applySessionClockTx(ctx.tx, {
      sessionId: args.sessionId,
      executionContext: args.executionContext,
      update: args.sessionClock!,
    });
  }
}

async function recordTriggers(ctx: CommitTxContext): Promise<void> {
  const { args } = ctx;
  const { runDropped } = ctx.drops.settled();
  await recordRuntimeTriggersTx(ctx.tx, {
    sessionId: args.sessionId,
    runtimeIds: (args.runtimeTriggers ?? []).filter(
      (runtimeId, index) =>
        !runDropped(args.runtimeTriggerRuns?.[index], runtimeId),
    ),
    now: new Date().toISOString(),
  });
}

async function publishExports(ctx: CommitTxContext): Promise<void> {
  const { args } = ctx;
  const dropped = ctx.drops.settled().runs;
  await publishCommittedExports(
    ctx.tx,
    args.results.filter((result) => !dropped.has(result)),
    {
      sessionId: args.sessionId,
      decls: ctx.exportDecls,
      loadOutputSchema: args.loadOutputSchema,
      mediaStore: args.mediaStore,
      now: args.sessionClock?.now,
    },
  );
}

async function settleCommitStatus(ctx: CommitTxContext): Promise<void> {
  const { args } = ctx;
  // Persisted results were written before commit; settle dropped ones
  // as failed so history, retries and reloads match what was saved.
  const failedRuntimes = ctx.drops.isolatedRuntimes();
  const settledOperations = settlementsOf(ctx.ledger.finalized());
  for (const turnId of args.turnIds) {
    await ctx.tx.setTurnResultCommitStatus(
      args.sessionId,
      turnId,
      "committed",
      failedRuntimes,
      settledOperations,
    );
  }
}
