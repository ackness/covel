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
 * Any proposal failure (a thrown store error OR a handler returning
 * `{ committed: false }`, e.g. a PreStateCommit veto or a schema-validation
 * reject) throws out of the callback, so the whole execution rolls back —
 * a sibling runtime that already committed is undone too. `commit_status` for
 * the execution's `turn_results` rows is settled inside that same transaction
 * on success, and best-effort to `failed` outside it on rollback.
 *
 * Stores without `withTransaction` (thin test mocks / legacy backends) degrade
 * to the previous one-at-a-time behaviour: no cross-runtime rollback is
 * promised, matching what those stores could do before.
 */

import type { DataStore, StoreTransaction } from "@covel/store";
import type { EventBus } from "@covel/events";
import type {
  ExecutionContext,
  Proposal,
  RuntimeManifest,
  SessionEvent,
} from "@covel/shared";
import type { HookPipeline } from "../hooks/pipeline.js";
import { runWithHookScope } from "../hooks/hook-scope.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import { processRuntimeResult } from "../session/session-runtime-result.js";

/** The subset of a manifest needed to resolve output kind, capabilities, and scope. */
type FinalizeManifest = Pick<
  RuntimeManifest,
  "name" | "pluginId" | "outputKind" | "capabilities"
>;

/** The loose runtime-result shape `processRuntimeResult` accepts (top-level or nested). */
type FinalizableResult = Parameters<typeof processRuntimeResult>[0];

interface FailedProposal {
  readonly proposal: Proposal;
  readonly error: string;
}

export interface FinalizeExecutionArgs {
  readonly store: DataStore;
  readonly sessionId: string;
  /** Run identity — used only for diagnostics on rollback. */
  readonly executionContext?: ExecutionContext;
  /**
   * Manifests for every runtime that may appear in `results`, used to resolve
   * each result's `outputKind` / `capabilities` and (by default) the hook
   * scope. Callers pass the session's active runtimes.
   */
  readonly runtimes: readonly FinalizeManifest[];
  /** Flattened results to commit: top-level plus nested recursiveCall results. */
  readonly results: readonly FinalizableResult[];
  /**
   * `turn_results` rows to settle. Nested rows reuse the top-level `turnId`,
   * so the top-level id alone settles them all. Empty when the caller persists
   * no `turn_results` row (resume).
   */
  readonly turnIds: readonly string[];
  readonly hookPipeline?: HookPipeline;
  readonly eventBus?: EventBus;
  readonly emitter?: TurnEmitter;
  /**
   * Override the hook scope's active plugin set. Defaults to the plugin ids in
   * `runtimes`. Resume passes its broader set (active runtimes plus the resumed
   * runtime's plugin) so cross-plugin commit hooks stay in scope.
   */
  readonly activePluginIds?: ReadonlySet<string>;
  /**
   * Caller-specific writes folded into the same transaction, run after every
   * result commits and before `commit_status` settles. Resume uses it for the
   * assistant turn message + resolved marker. A throw rolls the execution back.
   */
  readonly extraInTx?: (tx: StoreTransaction) => Promise<void>;
}

export interface FinalizeExecutionOutcome {
  readonly status: "committed" | "failed";
  /** SessionEvents from committed proposals, flushed only on success. */
  readonly events: readonly SessionEvent[];
  readonly failedProposals: readonly FailedProposal[];
  /** A non-proposal error (store error / `extraInTx` throw) that rolled back the execution. */
  readonly error?: string;
}

/** Carries the failed proposals out of the transaction callback for the caller. */
class ProposalCommitFailure extends Error {
  constructor(readonly failedProposals: readonly FailedProposal[]) {
    super(`${failedProposals.length} proposal(s) failed to commit`);
    this.name = "ProposalCommitFailure";
  }
}

let degradedWarned = false;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function settleTurnResults(
  store: Pick<DataStore, "setTurnResultCommitStatus">,
  sessionId: string,
  turnIds: readonly string[],
  status: "committed" | "failed",
): Promise<void> {
  for (const turnId of turnIds) {
    try {
      await store.setTurnResultCommitStatus(sessionId, turnId, status);
    } catch (err) {
      console.warn(
        `[finalize-execution] failed to settle commitStatus (${status}) for turn ${turnId}:`,
        errorMessage(err),
      );
    }
  }
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
    hookPipeline,
    eventBus,
    emitter,
    extraInTx,
  } = args;

  const outputKindByRuntime = new Map<string, string>();
  const capabilitiesByRuntime = new Map<string, readonly string[]>();
  for (const rt of runtimes) {
    outputKindByRuntime.set(rt.name, rt.outputKind ?? "plugin");
    capabilitiesByRuntime.set(rt.name, rt.capabilities ?? []);
  }
  const activePluginIds =
    args.activePluginIds ?? new Set(runtimes.map((rt) => rt.pluginId));

  const processOpts = (
    result: FinalizableResult,
    deferPostCommit?: (fn: () => Promise<void>) => void,
  ) => ({
    ...(hookPipeline ? { hookPipeline } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(emitter ? { emitter } : {}),
    capabilities: capabilitiesByRuntime.get(result.runtimeId) ?? [],
    ...(deferPostCommit ? { deferPostCommit } : {}),
  });
  const kindOf = (result: FinalizableResult): string =>
    outputKindByRuntime.get(result.runtimeId) ?? "plugin";

  // Commit (Pre/PostStateCommit) fires outside executeTurn's own hook scope, so
  // re-establish it here — session-scoped like every other commit site.
  return runWithHookScope({ activePluginIds }, async () => {
    // ── Preferred path: one transaction for the whole execution ──
    if (typeof store.withTransaction === "function") {
      // Externally-visible fan-out is buffered while the transaction is open
      // and flushed only after it COMMITs; a rollback discards the buffer, so
      // clients never see "committed" events for undone writes.
      const postCommit: Array<() => Promise<void>> = [];
      let committedEvents: readonly SessionEvent[] = [];
      try {
        committedEvents = await store.withTransaction(async (tx) => {
          const events: SessionEvent[] = [];
          for (const result of results) {
            const out = await processRuntimeResult(
              result,
              tx,
              sessionId,
              kindOf(result),
              processOpts(result, (fn) => postCommit.push(fn)),
            );
            events.push(...out.events);
            if (out.failedProposals.length > 0) {
              // Any proposal failure rolls back the whole execution.
              throw new ProposalCommitFailure(out.failedProposals);
            }
          }
          await extraInTx?.(tx);
          for (const turnId of turnIds) {
            await tx.setTurnResultCommitStatus(sessionId, turnId, "committed");
          }
          return events;
        });
      } catch (err) {
        // Rolled back. Drop the buffered fan-out; settle the rows to failed
        // outside the (now aborted) transaction.
        postCommit.length = 0;
        await settleTurnResults(store, sessionId, turnIds, "failed");
        if (err instanceof ProposalCommitFailure) {
          return {
            status: "failed",
            events: [],
            failedProposals: err.failedProposals,
          };
        }
        console.warn(
          `[finalize-execution] execution rolled back for session ${sessionId}` +
            (args.executionContext
              ? ` (execution ${args.executionContext.executionId})`
              : "") +
            `: ${errorMessage(err)}`,
        );
        return {
          status: "failed",
          events: [],
          failedProposals: [],
          error: errorMessage(err),
        };
      }

      // Committed. Flush deferred fan-out in order; a failing emit/hook must not
      // masquerade as a commit failure (the data IS committed).
      for (const fn of postCommit) {
        try {
          await fn();
        } catch (err) {
          console.warn(
            "[finalize-execution] post-commit fan-out failed:",
            errorMessage(err),
          );
        }
      }
      return {
        status: "committed",
        events: committedEvents,
        failedProposals: [],
      };
    }

    // ── Degraded path: no scoped transaction (thin mocks / legacy) ──
    // Commit one result at a time with inline fan-out — no cross-runtime
    // rollback is possible, so this matches the pre-existing best-effort
    // semantics on such stores.
    if (!degradedWarned) {
      degradedWarned = true;
      console.warn(
        "[finalize-execution] store has no withTransaction — committing without " +
          "whole-execution atomicity (no cross-runtime rollback).",
      );
    }
    const events: SessionEvent[] = [];
    const failedProposals: FailedProposal[] = [];
    for (const result of results) {
      const out = await processRuntimeResult(
        result,
        store,
        sessionId,
        kindOf(result),
        processOpts(result),
      );
      events.push(...out.events);
      failedProposals.push(...out.failedProposals);
    }
    if (failedProposals.length > 0) {
      // Cannot roll back the committed siblings; settle failed and skip
      // extraInTx (mirrors resume's "proposal failure precedes history writes").
      await settleTurnResults(store, sessionId, turnIds, "failed");
      return { status: "failed", events, failedProposals };
    }
    try {
      // DataStore satisfies StoreTransaction structurally (it has every member).
      await extraInTx?.(store as unknown as StoreTransaction);
    } catch (err) {
      await settleTurnResults(store, sessionId, turnIds, "failed");
      return {
        status: "failed",
        events: [],
        failedProposals: [],
        error: errorMessage(err),
      };
    }
    await settleTurnResults(store, sessionId, turnIds, "committed");
    return { status: "committed", events, failedProposals: [] };
  });
}
