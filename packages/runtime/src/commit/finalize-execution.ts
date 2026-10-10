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
 * it (`commit-dependencies.ts`). A story or setup runtime whose hard upstream
 * was dropped rolls back everything. A thrown store error always rolls back
 * everything.
 * `commit_status` for the execution's `turn_results` rows is settled inside
 * that same transaction on success, and best-effort to `failed` outside it on
 * rollback.
 *
 * `DataStore.withTransaction` is mandatory, so every execution has this same
 * atomic boundary in production and tests.
 */

import type {
  DataStore,
  StoreTransaction,
  SuspensionRecord,
  TurnMessageRecord,
} from "@covel/store";
import type { EventBus } from "@covel/events";
import type {
  ExecutionContext,
  Proposal,
  RuntimeManifest,
  SessionEvent,
} from "@covel/shared";
import type { HookPipeline } from "../hooks/pipeline.js";
import { buildHookSettings } from "../hooks/hook-settings.js";
import { runWithHookScope, type HookScope } from "../hooks/hook-scope.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import {
  commitPreparedProposals,
  prepareRuntimeProposals,
  type CommittableRuntimeResult,
  type PreparedRuntimeProposals,
} from "../session/session-runtime-result.js";
import {
  applySessionClockTx,
  needsSessionClockWrite,
  type SessionClockUpdate,
} from "./session-clock.js";
import {
  finalizeJobStatuses,
  type ExecutionJobOutcome,
} from "../job-status/job-status.js";
import { settleSetupRuntimes, type RanSetupRuntime } from "./setup-settle.js";
import { recordRuntimeTriggersTx } from "../trigger/trigger-ledger.js";
import {
  publishExecutionExports,
  type ExportDecl,
} from "./runtime-export-publish.js";
import {
  canonicalizeMediaRefs,
  type MediaOwnershipStore,
} from "../media/canonicalize-media-refs.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { isDimensionSnapshotSkip } from "../turn-executor/dimension-barrier.js";
import { storyOutputError } from "../agent-loop/story-output.js";
import {
  adoptRetryReadSets,
  bindDimensionProvider,
  needsSettlementReceipt,
  registerDimensionSettlements,
} from "./dimension-finalization.js";
import { droppedUpstream } from "./commit-dependencies.js";
import { flushPostCommit } from "./post-commit-fanout.js";

/**
 * Manifests resolve output kind, capabilities, scope, the persistent
 * `recordAs` export (docs 02 §3.4) and, for savepoint isolation, the hard
 * dependencies between runtimes. Callers pass their active runtimes; the
 * export VALUE's schema is loaded lazily via `loadOutputSchema` (below) only
 * when a success result actually needs it.
 */
type FinalizeManifest = RuntimeManifest;

/** The loose runtime-result shape the commit pipeline accepts (top-level or nested). */
type FinalizableResult = CommittableRuntimeResult;

interface FailedProposal {
  readonly proposal: Proposal;
  readonly error: string;
  readonly code?: string;
}

export interface FinalizeExecutionArgs {
  /** Execution-level veto/cancellation forbids all domain writes and success fan-out. */
  readonly abortReason?: string;
  /** Roll back when cancelled before the transaction commits; post-commit fan-out still runs. */
  readonly signal?: AbortSignal;
  readonly store: DataStore;
  readonly sessionId: string;
  /** Canonical identity of the execution being finalized. */
  readonly executionContext: ExecutionContext;
  /**
   * Manifests for every runtime that may appear in `results`, used to resolve
   * each result's `outputKind` / `capabilities` and (by default) the hook
   * scope. Callers pass the session's active runtimes.
   */
  readonly runtimes: readonly FinalizeManifest[];
  readonly imageFlowRuntimeIds?: readonly string[];
  /** Flattened results to commit: top-level plus nested recursiveCall results. */
  readonly results: readonly FinalizableResult[];
  /** Conversation entries committed atomically with this execution. */
  readonly journalMessages?: readonly TurnMessageRecord[];
  /** Runtime ids counted into the trigger ledger, one entry per run. */
  readonly runtimeTriggers?: readonly string[];
  /**
   * Continuations created while the runtimes executed. Callers stage these
   * instead of publishing them immediately; finalize persists them inside the
   * same transaction as every sibling proposal.
   */
  readonly suspensions?: readonly SuspensionRecord[];
  /**
   * `turn_results` rows to settle. Nested rows reuse the top-level `turnId`,
   * so the top-level id alone settles them all. Empty when the caller persists
   * no `turn_results` row (resume).
   */
  readonly turnIds: readonly string[];
  readonly hookPipeline?: HookPipeline;
  readonly eventBus?: EventBus;
  readonly emitter?: TurnEmitter;
  /** Reject proposals that are outside this execution's allowed effect set. */
  readonly proposalGuard?: (proposal: Proposal) => string | undefined;
  /**
   * Override the hook scope's active plugin set. Defaults to the plugin ids in
   * `runtimes`. Resume passes its broader set (active runtimes plus the resumed
   * runtime's plugin) so cross-plugin commit hooks stay in scope.
   */
  readonly activePluginIds?: ReadonlySet<string>;
  /** Frozen operation-start settings shared with execution; otherwise manifest defaults apply. */
  readonly hookSettings?: HookScope["settings"];
  /**
   * Caller-specific writes folded into the same transaction, run after every
   * result commits and before `commit_status` settles. Resume uses it for the
   * assistant turn message + resolved marker. A throw rolls the execution back.
   * `isolation` names the runtimes whose writes were dropped, so follow-up work
   * derived from them is not queued.
   */
  readonly extraInTx?: (
    tx: StoreTransaction,
    isolation: CommitIsolation,
  ) => Promise<void>;
  /**
   * Session-clock write folded into the same transaction: logical-turn
   * counting (from `executionContext`) plus the setup-band mirror / phase flip
   * (from `setupCompletion`). The player action path and the final sibling
   * resume supply it; manual / background / detached finalizes omit it and
   * leave the clock untouched. A
   * proposal failure rolls the clock write back with the domain writes.
   */
  readonly sessionClock?: SessionClockUpdate;
  /**
   * Setup runtimes that ran in this execution. Settled (attempt ledger
   * terminalised + pending/blocked mirror written) AFTER the domain outcome is
   * known, outside the transaction, so a rolled-back commit still burns an
   * attempt. Empty / omitted when no setup runtime ran.
   */
  readonly setupRan?: readonly RanSetupRuntime[];
  /**
   * Loads a producer's declared `output.schema` (containment-checked by the
   * loader) — called only for a `status: success` result whose runtime declares
   * `output.recordAs`, to validate and digest the published export value inside
   * the commit transaction. Required when a successful result declares recordAs;
   * a missing loader or schema fails the commit instead of dropping the export.
   */
  readonly loadOutputSchema?: (
    runtimeId: string,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /**
   * MediaStore read surface used to canonicalize + ownership-check MediaRefs in
   * published `recordAs` export values (docs 02 §2.1 / §3.4). Absent (thin
   * callers / tests) ⇒ export values are published without media processing.
   */
  readonly mediaStore?: MediaOwnershipStore;
}

export interface FinalizeExecutionOutcome {
  readonly status: "committed" | "failed";
  /** SessionEvents from committed proposals, flushed only on success. */
  readonly events: readonly SessionEvent[];
  /**
   * Rejected proposals. On `failed` they caused the rollback; on `committed`
   * they belong to optional runtimes whose writes were rolled back alone (see
   * `isolatedRuntimes`) while the story and every other runtime committed.
   */
  readonly failedProposals: readonly FailedProposal[];
  /**
   * Optional runtimes whose writes were dropped without failing the turn: a
   * rejected proposal, or a hard upstream that was itself dropped. Their
   * persisted results are settled as `failed` with `error`.
   */
  readonly isolatedRuntimes?: readonly IsolatedRuntime[];
  /** A non-proposal error (store error / `extraInTx` throw) that rolled back the execution. */
  readonly error?: string;
  /**
   * The data committed but some of its events could not be published; the
   * session's subscribers were reset to re-read it.
   */
  readonly fanOutFailed?: boolean;
}

export interface IsolatedRuntime {
  readonly runtimeId: string;
  readonly error: string;
}

export interface CommitIsolation {
  readonly droppedRuntimeIds: ReadonlySet<string>;
}

/** Results as committed: a runtime whose writes were dropped reads as failed. */
export function applyIsolatedRuntimes<
  T extends { readonly runtimeId: string; readonly status: string },
>(
  results: readonly T[],
  isolated: readonly IsolatedRuntime[] | undefined,
): T[] {
  const errors = new Map(
    (isolated ?? []).map((item) => [item.runtimeId, item.error]),
  );
  return results.map((result) =>
    errors.has(result.runtimeId)
      ? { ...result, status: "failed", error: errors.get(result.runtimeId) }
      : result,
  );
}

/** Carries the failed proposals out of the transaction callback for the caller. */
class ProposalCommitFailure extends Error {
  constructor(readonly failedProposals: readonly FailedProposal[]) {
    super(`${failedProposals.length} proposal(s) failed to commit`);
    this.name = "ProposalCommitFailure";
  }
}

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

/** Map one runtime result's status onto the job-terminal outcome vocabulary. */
function jobOutcomeForResult(status: string | undefined): ExecutionJobOutcome {
  switch (status) {
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "suspended":
      return "suspended";
    default:
      return "success";
  }
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

/**
 * Terminalise every job reported under this execution's progress scope. Runs
 * after the domain outcome is settled: a rolled-back execution fails all its
 * jobs; a committed one maps each job to its owning runtime's result status.
 * Job-status is append-only and non-transactional by design, so a failure here
 * is logged and never re-opens the domain outcome.
 */
async function terminalizeExecutionJobs(
  args: FinalizeExecutionArgs,
  outcome: FinalizeExecutionOutcome,
): Promise<void> {
  const status = outcome.status;
  const scopeId = args.executionContext?.executionId;
  if (!scopeId) return;
  try {
    const reported = await args.store.listJobStatus(args.sessionId, {
      progressScopeId: scopeId,
    });
    if (reported.length === 0) return;
    const statusByRuntime = new Map(
      applyIsolatedRuntimes(args.results, outcome.isolatedRuntimes).map(
        (result) => [result.runtimeId, result.status],
      ),
    );
    const groups = new Map<
      string,
      { pluginId: string; runtimeId: string; jobIds: Set<string> }
    >();
    for (const record of reported) {
      const key = `${record.pluginId}\u0000${record.runtimeId}`;
      const group = groups.get(key) ?? {
        pluginId: record.pluginId,
        runtimeId: record.runtimeId,
        jobIds: new Set<string>(),
      };
      group.jobIds.add(record.jobId);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const outcome: ExecutionJobOutcome =
        status === "failed"
          ? "failed"
          : jobOutcomeForResult(statusByRuntime.get(group.runtimeId));
      await finalizeJobStatuses(
        {
          store: args.store,
          ...(args.eventBus ? { eventBus: args.eventBus } : {}),
          sessionId: args.sessionId,
          progressScopeId: scopeId,
          pluginId: group.pluginId,
          runtimeId: group.runtimeId,
        },
        { outcome, reportedJobs: [...group.jobIds] },
      );
    }
  } catch (err) {
    console.warn(
      "[finalize-execution] job-status terminalisation failed:",
      errorMessage(err),
    );
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
    sessionClock,
  } = args;
  const executionContext = args.executionContext;
  const shouldWriteClock =
    sessionClock !== undefined &&
    needsSessionClockWrite(executionContext, sessionClock);

  const outputKindByRuntime = new Map<string, string>();
  for (const rt of runtimes) {
    outputKindByRuntime.set(rt.name, rt.outputKind ?? "plugin");
  }
  const activePluginIds =
    args.activePluginIds ?? new Set(runtimes.map((rt) => rt.pluginId));

  // Resolve declarations independently of optional host services. Missing
  // schema dependencies must never silently disable a declared export.
  const exportDeclByRuntime = new Map<string, ExportDecl>();
  for (const rt of runtimes) {
    const recordAs = rt.output?.recordAs;
    if (!recordAs) continue;
    exportDeclByRuntime.set(rt.name, {
      recordAs,
      pluginId: rt.pluginId,
      pluginVersion: rt.version ?? "0.0.0",
    });
  }
  const publishExports = async (
    sink: Parameters<typeof publishExecutionExports>[0]["sink"],
    committedResults: readonly FinalizableResult[],
  ): Promise<void> => {
    const exportedResults = committedResults.filter(
      (result) =>
        result.status === "success" &&
        exportDeclByRuntime.has(result.runtimeId),
    );
    if (exportedResults.length === 0) return;
    if (!args.loadOutputSchema) {
      throw new Error(
        "Cannot commit declared runtime exports without an output schema loader",
      );
    }
    const schemas = new Map<string, Readonly<Record<string, unknown>>>();
    for (const result of exportedResults) {
      const schema = await args.loadOutputSchema(result.runtimeId);
      if (!schema)
        throw new Error(
          `Missing output schema for runtime export ${result.runtimeId}`,
        );
      schemas.set(result.runtimeId, schema);
    }
    const mediaStore = args.mediaStore;
    await publishExecutionExports({
      sink,
      sessionId,
      results: committedResults,
      declFor: (runtimeId) => exportDeclByRuntime.get(runtimeId),
      loadOutputSchema: async (runtimeId) => schemas.get(runtimeId),
      committedAt: sessionClock?.now ?? new Date().toISOString(),
      ...(mediaStore
        ? {
            canonicalize: (value) =>
              canonicalizeMediaRefs(value, { store: mediaStore, sessionId }),
          }
        : {}),
    });
  };

  const saveSuspensions = async (
    sink: Pick<StoreTransaction, "saveSuspension">,
    deferPostCommit?: (fn: () => Promise<void>) => void,
  ): Promise<void> => {
    for (const suspension of args.suspensions ?? []) {
      if (suspension.sessionId !== sessionId) {
        throw new Error(
          `suspension ${suspension.id} belongs to session ${suspension.sessionId}, expected ${sessionId}`,
        );
      }
      await sink.saveSuspension(suspension);
      deferPostCommit?.(async () => {
        emitCommittedSuspension(eventBus, suspension);
      });
    }
  };

  const commitOpts = (
    result: FinalizableResult,
    deferPostCommit?: (fn: () => Promise<void>) => void,
  ) => ({
    ...(args.signal ? { signal: args.signal } : {}),
    ...(hookPipeline ? { hookPipeline } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(emitter ? { emitter } : {}),
    enforceImageFlow: args.imageFlowRuntimeIds?.includes(result.runtimeId),
    // A scoped retry repairs existing content unless it actually commits a
    // replacement story. Do not confuse this anchor with logical-turn counting.
    ...(executionContext.sourceTurnId &&
    !results.some(
      (candidate) =>
        candidate.turnId === result.turnId &&
        candidate.status === "success" &&
        outputKindByRuntime.get(candidate.runtimeId) === "story",
    )
      ? { messageSourceTurnId: executionContext.sourceTurnId }
      : {}),
    ...(args.proposalGuard ? { proposalGuard: args.proposalGuard } : {}),
    ...(deferPostCommit ? { deferPostCommit } : {}),
  });
  const kindOf = (result: FinalizableResult): string =>
    outputKindByRuntime.get(result.runtimeId) ?? "plugin";

  // A committed story must not be lost to an optional runtime's rejected
  // write. When the execution produced a story, every other non-setup runtime
  // commits in its own savepoint: a rejection rolls back that runtime alone.
  // Without a story (manual, background, detached, setup), the execution stays
  // all-or-nothing so a job never reports success for writes that did not land.
  const hasStory = results.some(
    (result) => kindOf(result) === "story" && result.status === "success",
  );
  const setupRuntimeIds = new Set(
    (args.setupRan ?? []).map((ran) => ran.runtimeId),
  );
  const isolates = (result: FinalizableResult): boolean =>
    hasStory &&
    kindOf(result) !== "story" &&
    !setupRuntimeIds.has(result.runtimeId);

  // Every exit funnels through here so reported jobs always reach a terminal
  // state, whatever the domain outcome.
  const conclude = async (
    outcome: FinalizeExecutionOutcome,
  ): Promise<FinalizeExecutionOutcome> => {
    await terminalizeExecutionJobs(args, outcome);
    if (args.setupRan && args.setupRan.length > 0) {
      try {
        await settleSetupRuntimes({
          store,
          sessionId,
          ran: args.setupRan,
          committed: outcome.status === "committed",
          now: sessionClock?.now ?? new Date().toISOString(),
        });
      } catch (err) {
        console.warn(
          "[finalize-execution] setup-runtime settle failed:",
          errorMessage(err),
        );
      }
    }
    return outcome;
  };

  // Commit (Pre/PostStateCommit) fires outside executeTurn's own hook scope, so
  // re-establish it here — session-scoped like every other commit site.
  const scope: HookScope = {
    activePluginIds,
    settings: args.hookSettings ?? buildHookSettings(runtimes, undefined),
  };
  return runWithHookScope(scope, async () => {
    // Externally-visible fan-out is buffered while the transaction is open and
    // flushed only after it commits. A rollback discards the buffer.
    const postCommit: Array<() => Promise<void>> = [];
    let committedEvents: readonly SessionEvent[] = [];
    const isolatedFailures: FailedProposal[] = [];
    // runtimeId -> why its writes were dropped.
    const isolated = new Map<string, string>();
    const manifestByRuntime = new Map(runtimes.map((rt) => [rt.name, rt]));
    // A result stands on its hard upstreams when it succeeded, and also when
    // it has writes to commit whatever its status: a guard that wrote and then
    // returned `{ skip: true }` leaves a skipped result with buffered writes.
    const lostUpstreamOf = (
      result: FinalizableResult,
      writes: PreparedRuntimeProposals,
    ): string | undefined => {
      const manifest = manifestByRuntime.get(result.runtimeId);
      return manifest &&
        (result.status === "success" || writes.proposals.length > 0)
        ? droppedUpstream(manifest, {
            runtimes,
            results,
            dropped: new Set(isolated.keys()),
          })
        : undefined;
    };
    try {
      if (args.abortReason !== undefined) {
        throw new Error(`Execution aborted: ${args.abortReason}`);
      }
      // Normalization, guards and PreStateCommit hooks run before the
      // transaction: hooks are plugin code with their own timeouts and must
      // never hold the store's write gate. The transaction then only writes.
      const prepared = new Map<FinalizableResult, PreparedRuntimeProposals>();
      for (const result of results) {
        args.signal?.throwIfAborted();
        prepared.set(
          result,
          await prepareRuntimeProposals(
            result,
            store,
            sessionId,
            kindOf(result),
            commitOpts(result),
          ),
        );
      }
      committedEvents = await store.withTransaction(async (tx) => {
        args.signal?.throwIfAborted();
        // A failed story cannot complete a player action. Optional state
        // extractors may fail independently after a valid narrative exists.
        // A story held back because the dimension provider failed is the same
        // case: committing would count the turn and keep the writes of the
        // runtimes before it, with no narrative.
        for (const result of results) {
          if (kindOf(result) !== "story") continue;
          const error =
            result.status === "failed"
              ? `Story runtime ${result.runtimeId} failed; the action was not committed.`
              : result.status === "success"
                ? storyOutputError(result.output)
                : isDimensionSnapshotSkip(result)
                  ? `Story runtime ${result.runtimeId} did not run because the dimension provider failed; the action was not committed.`
                  : undefined;
          if (error) throw new Error(error);
        }
        const dimensions = await bindDimensionProvider({
          tx,
          sessionId,
          runtimes,
        });
        const events: SessionEvent[] = [];
        // Settlement receipts freeze committed records. They are registered
        // where a runtime first needs one and again after the last runtime, so
        // a receipt never describes initialization that was vetoed, rewritten
        // or rolled back with its runtime.
        const registerSettlements = async (
          sink: StoreTransaction,
          defer: (fn: () => Promise<void>) => void,
        ): Promise<readonly SessionEvent[]> => {
          if (!dimensions) return [];
          const registered = await registerDimensionSettlements({
            sink,
            sessionId,
            scope: dimensions,
            runtimes,
            results,
          });
          for (const event of registered)
            defer(async () => {
              await emitter?.emit(
                "dimensions.settlement.changed",
                event.payload,
              );
              eventBus?.emit({
                id: event.id,
                type: "event",
                topic: "state",
                sessionId,
                timestamp: event.timestamp,
                payload: {
                  ...event.payload,
                  _subType: event.type,
                  turnId: event.turnId,
                },
              });
            });
          return registered;
        };
        const scopedRetry =
          executionContext.origin === "manual" &&
          executionContext.sourceTurnId !== undefined;
        const commitResult = async (
          result: FinalizableResult,
          sink: StoreTransaction,
          defer: (fn: () => Promise<void>) => void,
        ): Promise<readonly SessionEvent[]> => {
          const { proposals, failedProposals } = prepared.get(result)!;
          const committed: SessionEvent[] = [];
          const failed = [...failedProposals];
          const commitBatch = async (
            batch: readonly Proposal[],
          ): Promise<void> => {
            if (batch.length === 0) return;
            const out = await commitPreparedProposals(
              batch,
              sink,
              sessionId,
              result,
              commitOpts(result, defer),
            );
            committed.push(...out.events);
            failed.push(...out.failedProposals);
          };
          // The provider's own initialization commits first, so the receipt
          // its settlement update needs is built from what really landed.
          const settles =
            dimensions && result.pluginId === dimensions.provider
              ? proposals.findIndex(needsSettlementReceipt)
              : -1;
          if (settles < 0 || !dimensions) {
            await commitBatch(proposals);
          } else {
            await commitBatch(proposals.slice(0, settles));
            committed.push(...(await registerSettlements(sink, defer)));
            const updates = proposals.slice(settles);
            if (scopedRetry && result.status === "success")
              await adoptRetryReadSets({
                sink,
                sessionId,
                scope: dimensions,
                runtimes,
                results,
                proposals: updates,
              });
            await commitBatch(updates);
          }
          if (failed.length > 0) throw new ProposalCommitFailure(failed);
          return committed;
        };
        // Results arrive in execution order, so every upstream settles before
        // the runtimes that depend on it.
        for (const result of results) {
          args.signal?.throwIfAborted();
          const lostUpstream = lostUpstreamOf(result, prepared.get(result)!);
          if (lostUpstream) {
            const error = `upstream ${lostUpstream} did not commit`;
            // A story or setup runtime cannot stand on writes that did not land.
            if (!isolates(result)) {
              throw new Error(`${result.runtimeId}: ${error}`);
            }
            isolated.set(result.runtimeId, error);
            console.warn(
              `[finalize-execution] dropped writes of ${result.runtimeId} for session ${sessionId}: ${error}`,
            );
            continue;
          }
          if (!isolates(result) || !tx.savepoint) {
            events.push(
              ...(await commitResult(result, tx, (fn) => postCommit.push(fn))),
            );
            continue;
          }
          const buffered: Array<() => Promise<void>> = [];
          try {
            events.push(
              ...(await tx.savepoint((sp) =>
                commitResult(result, sp, (fn) => buffered.push(fn)),
              )),
            );
            postCommit.push(...buffered);
          } catch (err) {
            if (!(err instanceof ProposalCommitFailure)) throw err;
            isolatedFailures.push(...err.failedProposals);
            isolated.set(
              result.runtimeId,
              err.failedProposals.map((fp) => fp.error).join("; ") ||
                "proposal rejected",
            );
            console.warn(
              `[finalize-execution] dropped writes of ${result.runtimeId} for session ${sessionId}: ` +
                err.failedProposals.map((fp) => fp.error).join("; "),
            );
          }
        }
        // Every narrative owes a settlement, whether or not a runtime of this
        // execution asked for its receipt.
        events.push(
          ...(await registerSettlements(tx, (fn) => postCommit.push(fn))),
        );
        // A dropped runtime settles as failed: like any failed run, it adds
        // nothing to the conversation and does not count as a trigger.
        for (const message of args.journalMessages ?? []) {
          if (message.sourceRuntimeId && isolated.has(message.sourceRuntimeId))
            continue;
          await tx.appendTurnMessage(message);
        }
        await extraInTx?.(tx, {
          droppedRuntimeIds: new Set(isolated.keys()),
        });
        args.signal?.throwIfAborted();
        await saveSuspensions(tx, (fn) => postCommit.push(fn));
        if (shouldWriteClock) {
          await applySessionClockTx(tx, {
            sessionId,
            executionContext,
            update: sessionClock!,
          });
        }
        await recordRuntimeTriggersTx(tx, {
          sessionId,
          runtimeIds: (args.runtimeTriggers ?? []).filter(
            (runtimeId) => !isolated.has(runtimeId),
          ),
          now: new Date().toISOString(),
        });
        await publishExports(
          tx,
          results.filter((result) => !isolated.has(result.runtimeId)),
        );
        // Persisted results were written before commit; settle dropped ones
        // as failed so history, retries and reloads match what was saved.
        const failedRuntimes = [...isolated].map(([runtimeId, error]) => ({
          runtimeId,
          error,
        }));
        for (const turnId of turnIds) {
          await tx.setTurnResultCommitStatus(
            sessionId,
            turnId,
            "committed",
            failedRuntimes,
          );
        }
        args.signal?.throwIfAborted();
        return events;
      });
    } catch (err) {
      postCommit.length = 0;
      await settleTurnResults(store, sessionId, turnIds, "failed");
      if (err instanceof ProposalCommitFailure) {
        return conclude({
          status: "failed",
          events: [],
          failedProposals: err.failedProposals,
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
        error: errorMessage(err),
      });
    }

    const fanOutFailed = await flushPostCommit(postCommit, {
      sessionId,
      label: "finalize-execution",
      ...(eventBus ? { eventBus } : {}),
      ...(emitter ? { emitter } : {}),
    });
    return conclude({
      status: "committed",
      events: committedEvents,
      failedProposals: isolatedFailures,
      ...(fanOutFailed ? { fanOutFailed } : {}),
      ...(isolated.size > 0
        ? {
            isolatedRuntimes: [...isolated].map(([runtimeId, error]) => ({
              runtimeId,
              error,
            })),
          }
        : {}),
    });
  });
}
