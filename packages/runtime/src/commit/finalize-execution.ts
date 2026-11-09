/**
 * Whole-execution finalize primitive.
 *
 * One place that turns a completed execution's runtime results into committed
 * game state. It supersedes the hand-written per-caller commit loops (actions /
 * plugin-rpc runtime-turn) and the bespoke finalize block in the resume route:
 * every path now shares the same transaction boundary and failure semantics.
 *
 * Transaction boundary (the deliberate change from the old per-runtime one):
 * the FULL set of runtime results — top-level plus flattened nested
 * `recursiveCall` results — commits inside a SINGLE `store.withTransaction`.
 * Normalization and PreStateCommit hooks run before it opens, so plugin hook
 * code never holds the store's write gate. A rejected proposal (a handler
 * returning `{ committed: false }`, a PreStateCommit veto or a guard reject)
 * rolls back the whole execution, except for optional runtimes next to a
 * committed story: each of those commits in its own savepoint and a rejection
 * drops only its writes, plus the writes of every runtime that hard-depends on
 * it (`commit-dependencies.ts`), and of every runtime that read its
 * uncommitted plugin data (`read-dependencies.ts`). A story or setup runtime
 * whose hard upstream was dropped rolls back everything; one that read data
 * of a dropped runtime commits, and the trace records it. A thrown store
 * error always rolls back everything.
 *
 * Write-service operations ride on the results of the runs that called them
 * and commit with those runs' unit, after all of the unit's own writes, in
 * call order, each in its own savepoint. In an optional unit next to a story
 * a rejected operation drops the unit; in a story or setup unit next to a
 * story it drops only itself (the story stands); without a story it rolls
 * back the execution. Readers of a dropped operation's writes follow the
 * read-dependency rule above, with the operation as producer. Each
 * operation's record is settled with the `turn_results` rows.
 * `commit_status` for the execution's `turn_results` rows is settled inside
 * that same transaction on success, and best-effort to `failed` outside it on
 * rollback.
 *
 * `DataStore.withTransaction` is mandatory, so every execution has this same
 * atomic boundary in production and tests.
 *
 * This module wires the parts together:
 * - `finalize-types.ts`: the arguments and the outcome;
 * - `commit-options.ts`: the options each result's writes commit with;
 * - `operation-ledger.ts`: how each write-service operation ends;
 * - `commit-isolation.ts`: which units may drop alone, and which must drop;
 * - `commit-units.ts`: preparing the writes, then committing each unit;
 * - `commit-transaction.ts`: the transaction body, as ordered steps;
 * - `suspension-commit.ts` and `runtime-export-publish.ts`: two of its steps;
 * - `finalize-conclusion.ts`: everything after the domain outcome is known.
 */

import type { RuntimeManifest, SessionEvent } from "@covel/shared";
import { attachPresentationState } from "../presentation/state.js";
import { turnStoryCandidates } from "../presentation/turn-story.js";
import { SuspensionDataChangedError } from "../resume/suspension-baseline.js";
import { buildHookSettings } from "../hooks/hook-settings.js";
import { runWithHookScope, type HookScope } from "../hooks/hook-scope.js";
import type { FailedProposal } from "../session/session-runtime-result.js";
import { needsSessionClockWrite } from "./session-clock.js";
import { exportDeclsOf } from "./runtime-export-publish.js";
import { flushPostCommit } from "./post-commit-fanout.js";
import { commitOptionsFor } from "./commit-options.js";
import { OperationLedger } from "./operation-ledger.js";
import {
  commitUnitsOf,
  DroppedUnits,
  isolationPolicy,
} from "./commit-isolation.js";
import { prepareCommit, ProposalCommitFailure } from "./commit-units.js";
import { runCommitTransaction, type CommitRun } from "./commit-transaction.js";
import { concludeExecution } from "./finalize-conclusion.js";
import type {
  FinalizeExecutionArgs,
  FinalizeExecutionOutcome,
} from "./finalize-types.js";

export type {
  CommitIsolation,
  FinalizeExecutionArgs,
  FinalizeExecutionOutcome,
  FinalizedOperation,
  IsolatedRuntime,
} from "./finalize-types.js";
export { applyIsolatedRuntimes } from "./commit-isolation.js";
export { settleTurnResults } from "./finalize-conclusion.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function finalizeExecution(
  args: FinalizeExecutionArgs,
): Promise<FinalizeExecutionOutcome> {
  const {
    store,
    sessionId,
    runtimes,
    results,
    turnIds,
    eventBus,
    emitter,
    sessionClock,
  } = args;
  for (const result of results) {
    const state = args.presentationStates?.get(result.runId);
    if (state) attachPresentationState(result, state);
  }
  const executionContext = args.executionContext;
  const shouldWriteClock =
    sessionClock !== undefined &&
    needsSessionClockWrite(executionContext, sessionClock);
  const activePluginIds =
    args.activePluginIds ?? new Set(runtimes.map((rt) => rt.pluginId));
  const exportDecls = exportDeclsOf(runtimes);
  const options = commitOptionsFor(args);
  const ledger = new OperationLedger(results, args.operationRecords);
  const policy = isolationPolicy({
    results,
    runtimes,
    setupRan: args.setupRan,
    kindOf: options.kindOf,
  });
  const conclude = (outcome: FinalizeExecutionOutcome) =>
    concludeExecution(args, ledger, outcome);

  // Commit (Pre/PostStateCommit) fires outside executeTurn's own hook scope, so
  // re-establish it here — session-scoped like every other commit site.
  const scope: HookScope = {
    logicalTurn: executionContext.logicalTurn,
    activePluginIds,
    logicalKey:
      executionContext.logicalTurnId ??
      turnIds[0] ??
      results.at(-1)?.turnId ??
      executionContext.executionId,
    settings: args.hookSettings ?? buildHookSettings(runtimes, undefined),
    locale: args.hookLocale,
  };
  return runWithHookScope(scope, async () => {
    // Externally-visible fan-out is buffered while the transaction is open and
    // flushed only after it commits. A rollback discards the buffer.
    const postCommit: Array<() => Promise<void>> = [];
    const operationFailureMessages: { messageId: string; count: number }[] = [];
    let committedEvents: readonly SessionEvent[] = [];
    const topLevelStories = new Map<string, RuntimeManifest>();
    const nestedStoryMessageIds = new Set<string>();
    const isolatedFailures: FailedProposal[] = [];
    // Each unit is a top-level result with the results nested under it; it
    // commits or drops as one. Dropped unit -> why its writes were dropped.
    const drops = new DroppedUnits();
    try {
      if (args.abortReason !== undefined) {
        throw new Error(`Execution aborted: ${args.abortReason}`);
      }
      const units = commitUnitsOf(results, args.commitUnits);
      const prepared = await prepareCommit(args, options, ledger);
      const run: CommitRun = {
        args,
        options,
        ledger,
        policy,
        units,
        ...prepared,
        drops,
        postCommit,
        isolatedFailures,
        operationFailureMessages,
        topLevelStories,
        nestedStoryMessageIds,
        exportDecls,
        shouldWriteClock,
      };
      committedEvents = await store.withTransaction((tx) =>
        runCommitTransaction(tx, run),
      );
    } catch (err) {
      postCommit.length = 0;
      if (err instanceof ProposalCommitFailure) {
        return conclude({
          status: "failed",
          events: [],
          failedProposals: err.failedProposals,
          operations: [],
        });
      }
      console.warn(
        `[finalize-execution] execution rolled back for session ${sessionId}` +
          ` (execution ${args.executionContext.executionId}): ${errorMessage(err)}`,
      );
      return conclude({
        status: "failed",
        events: [],
        failedProposals: [],
        operations: [],
        error: errorMessage(err),
        ...(err instanceof SuspensionDataChangedError
          ? { code: err.code }
          : {}),
      });
    }

    const fanOutFailed = await flushPostCommit(postCommit, {
      sessionId,
      label: "finalize-execution",
      ...(eventBus ? { eventBus } : {}),
      ...(emitter ? { emitter } : {}),
    });
    const turnStories = new Set(
      turnStoryCandidates(topLevelStories, ([, runtime]) => runtime).map(
        ([messageId]) => messageId,
      ),
    );
    return conclude({
      status: "committed",
      events: committedEvents,
      turnStoryMessageIds: committedEvents.flatMap((event) =>
        typeof event.payload.messageId === "string" &&
        turnStories.has(event.payload.messageId)
          ? [event.payload.messageId]
          : [],
      ),
      failedProposals: isolatedFailures,
      operations: ledger.finalized(),
      operationFailureMessages,
      ...(fanOutFailed ? { fanOutFailed } : {}),
      ...(drops.size > 0 ? { isolatedRuntimes: drops.isolatedRuntimes() } : {}),
    });
  });
}
