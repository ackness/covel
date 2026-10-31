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
 */

import type {
  DataStore,
  StoreTransaction,
  SuspensionRecord,
  SuspensionWriteBaseline,
  TurnMessageRecord,
} from "@covel/store";
import type { EventBus } from "@covel/events";
import type {
  DeferredRuntimeJob,
  ExecutionContext,
  OperationFailureReason,
  OperationRecord,
  OperationSettlement,
  OperationStatus,
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  SessionEvent,
} from "@covel/shared";
import { isSetupRuntime } from "@covel/shared";
import {
  assertSuspensionWritesUnchanged,
  SuspensionDataChangedError,
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
import type { HookPipeline } from "../hooks/pipeline.js";
import { buildHookSettings } from "../hooks/hook-settings.js";
import { runWithHookScope, type HookScope } from "../hooks/hook-scope.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import {
  commitEligibility,
  commitPreparedProposals,
  prepareOperationProposals,
  prepareRuntimeProposals,
  type CommittableRuntimeResult,
  type FailedProposal,
  type PreparedRuntimeProposals,
} from "../session/session-runtime-result.js";
import { malformedDomainEffect } from "./session-output-normalizer.js";
import type { ProviderDatasets } from "../operations/operation-stage.js";
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
import { droppedUpstream, settleDroppedInputs } from "./commit-dependencies.js";
import { nestedRuntimesOf } from "../resume/suspended-nested-results.js";
import { flushPostCommit } from "./post-commit-fanout.js";
import {
  datasetPolicyResolver,
  type DatasetSchemas,
} from "./commit-plugin-data.js";

/**
 * Manifests resolve output kind, capabilities, scope, the persistent
 * `recordAs` export (docs 02 §3.4) and, for savepoint isolation, the hard
 * dependencies between runtimes. Callers pass their active runtimes; the
 * export VALUE's schema is loaded lazily via `loadOutputSchema` (below) only
 * when a success result actually needs it.
 */
type FinalizeManifest = RuntimeManifest;

/** Commit results retain the execution identity and status of a runtime result. */
type FinalizableResult = CommittableRuntimeResult &
  Pick<RuntimeResult, "runId" | "status" | "operations" | "operationWrites">;

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
   * The progress scope this execution's jobs were reported under, when it is
   * not `executionContext.executionId`: a resume continues the suspended
   * execution's scope. Only the jobs of runtimes in `results` are settled
   * there, and a rolled-back commit leaves them waiting for input, since the
   * suspension stays open for a retry.
   */
  readonly progressScopeId?: string;
  /**
   * Manifests for every runtime that may appear in `results`, used to resolve
   * each result's `outputKind` / `capabilities` and (by default) the hook
   * scope. Callers pass the session's active runtimes.
   */
  readonly runtimes: readonly FinalizeManifest[];
  readonly imageFlowRuntimeIds?: readonly string[];
  /**
   * Flattened results to commit, in execution order: top-level results, each
   * preceded by the nested recursiveCall results of its successful handler.
   */
  readonly results: readonly FinalizableResult[];
  /** Execution-wide records, including recursive runs abandoned by a parent. */
  readonly operationRecords?: readonly OperationRecord[];
  /**
   * How `results` group into commit units: the length of each unit, in order.
   * A unit is one top-level result preceded by every result nested under it
   * (children before their parent), and it commits or drops as one. Omitted,
   * every result is its own unit.
   */
  readonly commitUnits?: readonly number[];
  /** Conversation entries committed atomically with this execution. */
  readonly journalMessages?: readonly TurnMessageRecord[];
  /**
   * The `runId` of the result each journal message came from, by message id.
   * A message without an entry is dropped when a top-level runtime with its
   * `sourceRuntimeId` is dropped.
   */
  readonly journalMessageRuns?: Readonly<Record<string, string>>;
  /** Runtime ids counted into the trigger ledger, one entry per run. */
  readonly runtimeTriggers?: readonly string[];
  /**
   * The `runId` of each `runtimeTriggers` entry, at the same index. Without
   * it, an entry is dropped when a top-level runtime of that id is dropped.
   */
  readonly runtimeTriggerRuns?: readonly string[];
  /**
   * Continuations created while the runtimes executed. Callers stage these
   * instead of publishing them immediately; finalize persists them inside the
   * same transaction as every sibling proposal, each with the records its
   * buffered proposals write as they are then (`takenUnder.writes`). Saving
   * one voids every other pending suspension of the same runtime, settled
   * like an abandon: a runtime has one suspension that can be resumed.
   */
  readonly suspensions?: readonly SuspensionRecord[];
  /**
   * The `runId` of the result each continuation came from, by suspension id.
   * A continuation whose run was dropped at commit is never saved; when no
   * continuation of the execution survives, the dropped ones end as if
   * abandoned: their turn counts and the jobs they held back are queued.
   */
  readonly suspensionRuns?: Readonly<Record<string, string>>;
  /**
   * A resumed suspension's `takenUnder.writes`. They are read again first in
   * the transaction; when one changed, nothing commits and the outcome's
   * `code` is `suspension-data-changed`.
   */
  readonly writeBaseline?: readonly SuspensionWriteBaseline[];
  /**
   * Queues, in the commit transaction, the detached jobs that the turn of a
   * voided older suspension held back (see `suspensions`). A commit that has
   * such jobs and no way to queue them rolls back instead of losing them.
   */
  readonly enqueueReleasedJobsInTx?: (
    tx: StoreTransaction,
    jobs: readonly DeferredRuntimeJob[],
  ) => Promise<void>;
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
  /** The session's content locale, handed to the commit hooks. */
  readonly hookLocale?: string;
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
  /**
   * Compiled dataset record schemas by plugin id, then namespace, captured
   * with the runtimes. Every plugin-data write into a namespace a runtime of
   * its package declares in `datasets` is checked against them; a declared
   * dataset without a schema here refuses every write.
   */
  readonly datasetSchemas?: DatasetSchemas;
  /**
   * Declared datasets and compiled schemas of the providers of write
   * services the execution called, by plugin id. Their operations' writes
   * are checked against them, also when no runtime of the provider ran.
   */
  readonly providerDatasets?: Readonly<Record<string, ProviderDatasets>>;
  /**
   * Plugin-data read dependencies by reader `runId`: the producer ids whose
   * uncommitted writes the reader's reads saw (`read-dependencies.ts`). A
   * producer id is the `runId` of a result, or the id of a write-service
   * operation on one. An auxiliary unit with a member that read a dropped
   * producer outside the unit is dropped too; a story or setup unit commits,
   * with one `read-dependency.kept` trace row per dropped producer.
   */
  readonly readDependencies?: Readonly<Record<string, readonly string[]>>;
}

/** How one write-service operation ended. */
export interface FinalizedOperation {
  readonly id: string;
  readonly status: OperationStatus;
  readonly reason?: OperationFailureReason;
  readonly contract: string;
  readonly invokedBy: OperationRecord["invokedBy"];
}

export interface FinalizeExecutionOutcome {
  /** Internal provenance receipt; only committed top-level narrative messages. */
  readonly topLevelNarrativeMessageIds?: readonly string[];
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
   * rejected proposal, or a hard upstream that was itself dropped. A dropped
   * top-level runtime takes the results nested under it along; each dropped
   * run has its own entry. Their persisted results are settled as `failed`
   * with `error`.
   */
  readonly isolatedRuntimes?: readonly IsolatedRuntime[];
  /** A non-proposal error (store error / `extraInTx` throw) that rolled back the execution. */
  readonly error?: string;
  /**
   * Set when a record the resumed suspension's buffered proposals write
   * changed after it was taken (`writeBaseline`): nothing was written.
   */
  readonly code?: "suspension-data-changed";
  /**
   * The data committed but some of its events could not be published; the
   * session's subscribers were reset to re-read it.
   */
  readonly fanOutFailed?: boolean;
  /**
   * Every write-service operation of the execution and how it ended, as
   * saved with the `turn_results` rows. Its rejected writes are in
   * `failedProposals`.
   */
  readonly operations: readonly FinalizedOperation[];
}

export interface IsolatedRuntime {
  readonly cause: "rejected" | "upstream" | "read" | "nested";
  readonly runtimeId: string;
  /**
   * The dropped run. The same runtime can run nested and at top level in one
   * execution, so a consumer matches on this when it is present.
   */
  readonly runId?: string;
  readonly error: string;
}

export interface CommitIsolation {
  /** Top-level runtimes of this execution whose writes were dropped. */
  readonly droppedRuntimeIds: ReadonlySet<string>;
}

/** Results as committed: a runtime whose writes were dropped reads as failed. */
export function applyIsolatedRuntimes<
  T extends {
    readonly runtimeId: string;
    readonly runId?: string;
    readonly status: string;
  },
>(
  results: readonly T[],
  isolated: readonly IsolatedRuntime[] | undefined,
): T[] {
  const byRun = new Map<string, string>();
  const byRuntime = new Map<string, string>();
  for (const item of isolated ?? []) {
    if (item.runId !== undefined) byRun.set(item.runId, item.error);
    else byRuntime.set(item.runtimeId, item.error);
  }
  return results.map((result) => {
    const error =
      (result.runId !== undefined ? byRun.get(result.runId) : undefined) ??
      byRuntime.get(result.runtimeId);
    return error !== undefined
      ? { ...result, status: "failed", error }
      : result;
  });
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

/** A top-level result and the nested results that commit or drop with it. */
interface CommitUnit {
  /** The top-level result, last of `members`. */
  readonly root: FinalizableResult;
  /** Children before their parent, `root` last. */
  readonly members: readonly FinalizableResult[];
}

/** One write-service operation and the run that called it. */
interface OperationEntry {
  readonly record: OperationRecord;
  /** Its staged writes, carrying the provider's identity. */
  readonly writes: readonly Proposal[];
  readonly member: FinalizableResult;
}

/** What a dropped producer a reader depended on was. */
type LostRead =
  | { readonly reader: FinalizableResult; readonly producer: FinalizableResult }
  | { readonly reader: FinalizableResult; readonly operation: OperationEntry };

function lostProducerName(lost: LostRead): string {
  return "operation" in lost
    ? lost.operation.record.contract
    : lost.producer.runtimeId;
}

/** The failure reason of an operation whose writes were refused. */
function operationFailureReason(
  failed: readonly FailedProposal[],
): OperationFailureReason {
  return failed.some((item) => item.code === "conflict")
    ? "conflict"
    : "rejected";
}

/**
 * An operation's `update` that the commit could not apply passed the same
 * check when it was staged: the value moved since. That is a conflict, not a
 * faulty write of the provider.
 */
function asOperationFailures(
  failed: readonly FailedProposal[],
): FailedProposal[] {
  return failed.map((item) =>
    item.code === "data-op-rejected" &&
    item.proposal.type === "plugin.data.update"
      ? { ...item, code: "conflict" }
      : item,
  );
}

function commitUnitsOf(
  results: readonly FinalizableResult[],
  sizes: readonly number[] | undefined,
): CommitUnit[] {
  if (!sizes) return results.map((root) => ({ root, members: [root] }));
  const units: CommitUnit[] = [];
  let start = 0;
  for (const size of sizes) {
    const members = results.slice(start, start + size);
    const root = members.at(-1);
    if (size < 1 || members.length !== size || !root) break;
    units.push({ root, members });
    start += size;
  }
  if (start !== results.length) {
    throw new Error(
      `commitUnits cover ${start} of ${results.length} results; the commit plan is malformed`,
    );
  }
  return units;
}

/** One entry per dropped run, in commit order. */
function isolatedRuntimesOf(
  isolated: ReadonlyMap<
    CommitUnit,
    { error: string; cause: IsolatedRuntime["cause"] }
  >,
): IsolatedRuntime[] {
  return [...isolated].flatMap(([unit, { error, cause }]) =>
    unit.members.map((member) => ({
      runtimeId: member.runtimeId,
      runId: member.runId,
      cause: member === unit.root ? cause : "nested",
      error:
        member === unit.root
          ? error
          : `dropped with ${unit.root.runtimeId}: ${error}`,
    })),
  );
}

async function settleTurnResults(
  store: Pick<DataStore, "setTurnResultCommitStatus">,
  sessionId: string,
  turnIds: readonly string[],
  status: "committed" | "failed",
  settledOperations: readonly OperationSettlement[] = [],
): Promise<void> {
  for (const turnId of turnIds) {
    try {
      await store.setTurnResultCommitStatus(
        sessionId,
        turnId,
        status,
        [],
        settledOperations,
      );
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
 * A suspended runtime's jobs wait for input, a claimed success too, since its
 * writes are held until the suspension is resumed; so do the jobs of the
 * `ctx.recursiveCall` children saved with it, which share this scope. A
 * reporting runtime with no result at all (a child whose parent failed) is
 * cancelled.
 * In a continued scope (a resume) only the jobs of the runtimes this
 * execution ran are settled, and a rollback returns them, including a
 * claimed success whose writes did not land, to waiting for input.
 * Job-status is append-only and non-transactional by design, so a failure here
 * is logged and never re-opens the domain outcome.
 */
async function terminalizeExecutionJobs(
  args: FinalizeExecutionArgs,
  outcome: FinalizeExecutionOutcome,
): Promise<void> {
  const status = outcome.status;
  const continued = args.progressScopeId;
  const scopeId = continued ?? args.executionContext?.executionId;
  if (!scopeId) return;
  try {
    const reported = await args.store.listJobStatus(args.sessionId, {
      progressScopeId: scopeId,
    });
    if (reported.length === 0) return;
    // Jobs name a runtime, not a run. When a runtime ran both nested and at
    // top level, its top-level run decides.
    const settled = applyIsolatedRuntimes(
      args.results,
      outcome.isolatedRuntimes,
    );
    const roots = new Set(
      commitUnitsOf(args.results, args.commitUnits).map((unit) => unit.root),
    );
    const statusByRuntime = new Map<string, string>();
    for (const preferRoot of [false, true])
      args.results.forEach((result, index) => {
        if (roots.has(result) === preferRoot)
          statusByRuntime.set(result.runtimeId, settled[index]!.status);
      });
    // A suspended runtime's `ctx.recursiveCall` children are not among the
    // results: their saved results wait inside its suspension. Their tasks
    // follow the runtime that holds them, its own entry staying first.
    for (const suspension of args.suspensions ?? []) {
      const holder = statusByRuntime.get(suspension.runtimeId);
      if (holder === undefined) continue;
      for (const { runtimeId } of nestedRuntimesOf(suspension))
        if (!statusByRuntime.has(runtimeId))
          statusByRuntime.set(runtimeId, holder);
    }
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
      // A continued scope also holds jobs of runtimes that ran in the
      // suspended execution and were settled by its own commit.
      if (continued && !statusByRuntime.has(group.runtimeId)) continue;
      const rolledBack = status === "failed";
      // A runtime that reported jobs and has no result here was a
      // `ctx.recursiveCall` child of a parent that did not succeed: its work
      // was not committed and nobody failed it, so a success it claimed is
      // taken back too.
      const discarded = !rolledBack && !statusByRuntime.has(group.runtimeId);
      const outcome: ExecutionJobOutcome = rolledBack
        ? continued
          ? "suspended"
          : "failed"
        : statusByRuntime.has(group.runtimeId)
          ? jobOutcomeForResult(statusByRuntime.get(group.runtimeId))
          : "skipped";
      await finalizeJobStatuses(
        {
          store: args.store,
          ...(args.eventBus ? { eventBus: args.eventBus } : {}),
          sessionId: args.sessionId,
          progressScopeId: scopeId,
          pluginId: group.pluginId,
          runtimeId: group.runtimeId,
        },
        {
          outcome,
          reportedJobs: [...group.jobIds],
          rolledBack: rolledBack || discarded,
        },
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
    outputKindByRuntime.set(rt.name, rt.outputKind ?? "system");
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
    tx: StoreTransaction,
    deferPostCommit: (fn: () => Promise<void>) => void,
    dropped: {
      /** Suspension ids whose run was dropped at commit. */
      readonly suspensionIds: ReadonlySet<string>;
      /** Held-back jobs as this execution committed them. */
      readonly settleJobs: (
        jobs: readonly DeferredRuntimeJob[],
      ) => readonly DeferredRuntimeJob[];
    },
  ): Promise<void> => {
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
                withheldRuntimeJobs: dropped.settleJobs(
                  continuation.withheldRuntimeJobs as readonly DeferredRuntimeJob[],
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
      if (
        continuation.executionContext.countPolicy === "complete-player-turn"
      ) {
        await applySessionClockTx(tx, {
          sessionId,
          executionContext: continuation.executionContext,
          update: { now },
        });
      }
      const jobs = dropped.settleJobs(
        (continuation.withheldRuntimeJobs ??
          []) as readonly DeferredRuntimeJob[],
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
          { store, ...(eventBus ? { eventBus } : {}) },
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
  };

  // Providers of write services are checked like packages that ran, also
  // when none of their runtimes did.
  const providerDatasets = Object.entries(args.providerDatasets ?? {});
  const datasetPolicy = datasetPolicyResolver(
    [
      ...runtimes,
      ...providerDatasets.map(([pluginId, { datasets }]) => ({
        pluginId,
        datasets,
      })),
    ],
    {
      ...Object.fromEntries(
        providerDatasets.map(([pluginId, { schemas }]) => [pluginId, schemas]),
      ),
      ...args.datasetSchemas,
    },
  );
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
    ...(args.mediaStore ? { mediaStore: args.mediaStore } : {}),
    ...(datasetPolicy ? { datasetPolicy } : {}),
    ...(deferPostCommit ? { deferPostCommit } : {}),
  });
  const kindOf = (result: FinalizableResult): string =>
    outputKindByRuntime.get(result.runtimeId) ?? "system";

  // Write-service operations, with the run that called them. Only a staged
  // operation of a result whose own writes may commit can commit.
  const operations: OperationEntry[] = results.flatMap((member) =>
    (member.operations ?? []).map((record) => ({
      record,
      writes: member.operationWrites?.[record.id] ?? [],
      member,
    })),
  );
  const operationById = new Map(
    operations.map((entry) => [entry.record.id, entry]),
  );
  const abandonedOperations = (args.operationRecords ?? []).filter(
    (record) => !operationById.has(record.id),
  );
  const operationState = new Map<
    string,
    { status: OperationStatus; reason?: OperationFailureReason }
  >();
  const settleOperation = (
    entry: OperationEntry,
    status: OperationStatus,
    reason?: OperationFailureReason,
  ) =>
    operationState.set(entry.record.id, {
      status,
      ...(reason !== undefined ? { reason } : {}),
    });
  for (const entry of operations) {
    const committable =
      entry.record.status === "staged" &&
      entry.writes.length > 0 &&
      commitEligibility(entry.member) !== "none" &&
      !malformedDomainEffect(entry.member.effects);
    if (committable) settleOperation(entry, "staged");
    else
      settleOperation(
        entry,
        "discarded",
        entry.record.reason ?? "caller-dropped",
      );
  }
  const operationDropped = (entry: OperationEntry): boolean => {
    const status = operationState.get(entry.record.id)?.status;
    return status === "failed" || status === "discarded";
  };
  /** Operations of `members` that can still commit, in call order. */
  const stagedOperationsOf = (
    members: readonly FinalizableResult[],
  ): OperationEntry[] => {
    const set = new Set(members);
    return operations
      .filter(
        (entry) =>
          set.has(entry.member) &&
          operationState.get(entry.record.id)?.status === "staged",
      )
      .sort((a, b) => a.record.seq - b.record.seq);
  };
  const finalizedOperations = (
    override?: Pick<FinalizedOperation, "status" | "reason">,
  ): FinalizedOperation[] =>
    [...operations.map((entry) => entry.record), ...abandonedOperations]
      .sort((a, b) => a.seq - b.seq)
      .map((record) => {
        const state = override ??
          operationState.get(record.id) ?? {
            status: "discarded" as const,
            reason: "caller-dropped" as const,
          };
        return {
          id: record.id,
          status: state.status,
          ...(state.reason !== undefined ? { reason: state.reason } : {}),
          contract: record.contract,
          invokedBy: record.invokedBy,
        };
      });
  const settlementsOf = (
    finalized: readonly FinalizedOperation[],
  ): OperationSettlement[] =>
    finalized.map(({ id, status, reason }) => ({
      id,
      status,
      ...(reason !== undefined ? { reason } : {}),
    }));
  const operationCommitOpts = (
    entry: OperationEntry,
    deferPostCommit?: (fn: () => Promise<void>) => void,
  ) => ({
    ...commitOpts(entry.member, deferPostCommit),
    enforceImageFlow: false,
  });

  // A committed story must not be lost to an optional runtime's rejected
  // write. When the execution produced a story, every other non-setup unit
  // commits in its own savepoint: a rejection rolls back that unit alone.
  // Without a story (manual, background, detached, setup), the execution stays
  // all-or-nothing so a job never reports success for writes that did not land.
  const hasStory = results.some(
    (result) => kindOf(result) === "story" && result.status === "success",
  );
  // A setup run is known by its manifest's stage: `setupRan` lists only the
  // setup runtimes this execution scheduled, not one a parent called nested.
  const setupRuntimeIds = new Set([
    ...(args.setupRan ?? []).map((ran) => ran.runtimeId),
    ...runtimes.filter(isSetupRuntime).map((runtime) => runtime.name),
  ]);
  const protects = (result: FinalizableResult): boolean =>
    kindOf(result) === "story" || setupRuntimeIds.has(result.runtimeId);
  // A unit holding a story or setup run anywhere, even nested, stays with the
  // execution: dropping it on its own could drop the very story that made
  // isolation safe.
  const isolates = (unit: CommitUnit): boolean =>
    hasStory && !unit.members.some(protects);

  // Every exit funnels through here so reported jobs always reach a terminal
  // state, whatever the domain outcome.
  const conclude = async (
    outcome: FinalizeExecutionOutcome,
  ): Promise<FinalizeExecutionOutcome> => {
    if (outcome.status === "failed") {
      // Nothing of the execution landed, its operations included.
      const operations = finalizedOperations({
        status: "discarded",
        reason: "execution-failed",
      });
      await settleTurnResults(
        store,
        sessionId,
        turnIds,
        "failed",
        settlementsOf(operations),
      );
      outcome = { ...outcome, operations };
    }
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
    let committedEvents: readonly SessionEvent[] = [];
    const topLevelNarrativeMessageIds = new Set<string>();
    const isolatedFailures: FailedProposal[] = [];
    // Each unit is a top-level result with the results nested under it; it
    // commits or drops as one. Dropped unit -> why its writes were dropped.
    let units: CommitUnit[] = [];
    const isolated = new Map<
      CommitUnit,
      { error: string; cause: IsolatedRuntime["cause"] }
    >();
    const preparedOperations = new Map<
      OperationEntry,
      PreparedRuntimeProposals
    >();
    // Top-level runtime ids are unique within an execution, so dependency
    // checks, which only cross units at top level, can key on them.
    const droppedRootIds = (): Set<string> =>
      new Set([...isolated.keys()].map((unit) => unit.root.runtimeId));
    const droppedRuns = (): Set<FinalizableResult> =>
      new Set([...isolated.keys()].flatMap((unit) => unit.members));
    const manifestByRuntime = new Map(runtimes.map((rt) => [rt.name, rt]));
    // A unit stands on its top-level result's hard upstreams when that result
    // succeeded, and also when the unit has writes to commit whatever its
    // status: a guard that wrote and then returned `{ skip: true }` leaves a
    // skipped result with buffered writes. Nested results depend only on
    // results of their own nested execution, which sit in the same unit.
    const lostUpstreamOf = (
      unit: CommitUnit,
      prepared: ReadonlyMap<FinalizableResult, PreparedRuntimeProposals>,
    ): string | undefined => {
      const manifest = manifestByRuntime.get(unit.root.runtimeId);
      return manifest &&
        (unit.root.status === "success" ||
          unit.members.some(
            (member) => prepared.get(member)!.proposals.length > 0,
          ))
        ? droppedUpstream(manifest, {
            runtimes,
            results: units.map((candidate) => candidate.root),
            dropped: droppedRootIds(),
          })
        : undefined;
    };
    // Producers precede their readers in commit order: a reader's visible
    // set is taken from results completed before it started, children
    // before their parent. Edges inside one unit are ignored, as the unit
    // commits or drops as one.
    const resultByRun = new Map(
      results.map((result) => [result.runId, result]),
    );
    const positionOf = new Map(results.map((result, index) => [result, index]));
    // An operation commits at the end of its caller's unit.
    const unitRootOf = (member: FinalizableResult): FinalizableResult =>
      units.find((unit) => unit.members.includes(member))?.root ?? member;
    const lostReadsOf = (
      unit: CommitUnit,
      prepared: ReadonlyMap<FinalizableResult, PreparedRuntimeProposals>,
    ): LostRead[] => {
      const edges = args.readDependencies;
      if (
        !edges ||
        !(
          unit.root.status === "success" ||
          unit.members.some(
            (member) => prepared.get(member)!.proposals.length > 0,
          )
        )
      )
        return [];
      const members = new Set(unit.members);
      const dropped = droppedRuns();
      const lost = new Map<FinalizableResult | OperationEntry, LostRead>();
      for (const reader of unit.members) {
        for (const producerId of edges[reader.runId] ?? []) {
          // A producer is a run or a write-service operation; an unknown id
          // has nothing to drop.
          const operation = operationById.get(producerId);
          if (!resultByRun.has(producerId) && operation) {
            if (members.has(operation.member)) continue;
            if (
              positionOf.get(unitRootOf(operation.member))! >
              positionOf.get(reader)!
            ) {
              console.warn(
                `[finalize-execution] ${reader.runtimeId} read data written through ${operation.record.contract}, which commits after it; the dependency is ignored`,
              );
              continue;
            }
            if (operationDropped(operation) && !lost.has(operation))
              lost.set(operation, { reader, operation });
            continue;
          }
          const producer = resultByRun.get(producerId);
          if (!producer || members.has(producer)) continue;
          if (positionOf.get(producer)! > positionOf.get(reader)!) {
            console.warn(
              `[finalize-execution] ${reader.runtimeId} read data of ${producer.runtimeId}, which commits after it; the dependency is ignored`,
            );
            continue;
          }
          if (dropped.has(producer) && !lost.has(producer))
            lost.set(producer, { reader, producer });
        }
      }
      return [...lost.values()];
    };
    try {
      if (args.abortReason !== undefined) {
        throw new Error(`Execution aborted: ${args.abortReason}`);
      }
      units = commitUnitsOf(results, args.commitUnits);
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
        // A run's operations are prepared after its own writes.
        for (const entry of stagedOperationsOf([result])) {
          args.signal?.throwIfAborted();
          preparedOperations.set(
            entry,
            await prepareOperationProposals(
              entry.writes,
              operationCommitOpts(entry),
            ),
          );
        }
      }
      committedEvents = await store.withTransaction(async (tx) => {
        args.signal?.throwIfAborted();
        // A resume must not put back what a later write replaced: compare the
        // records its buffered proposals write before anything is written.
        await assertSuspensionWritesUnchanged(
          tx,
          sessionId,
          args.writeBaseline ?? [],
        );
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
          logicalTurn: executionContext.logicalTurn,
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
                proposals: updates,
              });
            await commitBatch(updates);
          }
          if (failed.length > 0) throw new ProposalCommitFailure(failed);
          return committed;
        };
        // A unit's results commit children first, then the parent; units
        // arrive in execution order, so every upstream settles before the
        // runtimes that depend on it.
        const commitUnit = async (
          unit: CommitUnit,
          sink: StoreTransaction,
          defer: (fn: () => Promise<void>) => void,
        ): Promise<readonly SessionEvent[]> => {
          const committed: SessionEvent[] = [];
          for (const member of unit.members) {
            args.signal?.throwIfAborted();
            const memberEvents = await commitResult(member, sink, defer);
            committed.push(...memberEvents);
            if (
              member === unit.root &&
              runtimes.some(
                (runtime) =>
                  runtime.name === member.runtimeId &&
                  runtime.pluginId === member.pluginId &&
                  runtime.outputKind === "story" &&
                  runtime.outputContract === "narrative-engine@2",
              )
            ) {
              for (const event of memberEvents)
                if (
                  event.type === "narrative.completed" &&
                  event.payload.kind === "story" &&
                  typeof event.payload.messageId === "string"
                )
                  topLevelNarrativeMessageIds.add(event.payload.messageId);
            }
          }
          return committed;
        };
        // One operation's writes, after its unit's own writes. Any refusal
        // fails the whole operation; an `update` that no longer applies is
        // a conflict.
        const commitOperation = async (
          entry: OperationEntry,
          sink: StoreTransaction,
          defer: (fn: () => Promise<void>) => void,
        ): Promise<readonly SessionEvent[]> => {
          const { proposals, failedProposals } = preparedOperations.get(entry)!;
          if (failedProposals.length > 0)
            throw new ProposalCommitFailure(failedProposals);
          const out = await commitPreparedProposals(
            proposals,
            sink,
            sessionId,
            {
              runtimeId: `service:${entry.record.service}`,
              turnId: entry.member.turnId,
            },
            operationCommitOpts(entry, defer),
          );
          if (out.failedProposals.length > 0)
            throw new ProposalCommitFailure(
              asOperationFailures(out.failedProposals),
            );
          return out.events;
        };
        // A story-attached operation that did not land: only it is dropped.
        const failOperation = (
          entry: OperationEntry,
          failed: readonly FailedProposal[],
        ) => {
          isolatedFailures.push(
            ...failed.map((item) => ({
              ...item,
              operationId: entry.record.id,
            })),
          );
          settleOperation(entry, "failed", operationFailureReason(failed));
          console.warn(
            `[finalize-execution] ${entry.record.contract} called by ${entry.member.runtimeId} did not commit for session ${sessionId}: ` +
              failed.map((fp) => fp.error).join("; "),
          );
        };
        const dropUnitOperations = (unit: CommitUnit) => {
          for (const entry of stagedOperationsOf(unit.members))
            settleOperation(entry, "discarded", "caller-dropped");
        };
        for (const unit of units) {
          args.signal?.throwIfAborted();
          const { root } = unit;
          const lostUpstream = lostUpstreamOf(unit, prepared);
          if (lostUpstream) {
            const error = `upstream ${lostUpstream} did not commit`;
            // A story or setup runtime cannot stand on writes that did not land.
            if (!isolates(unit)) {
              throw new Error(`${root.runtimeId}: ${error}`);
            }
            isolated.set(unit, { error, cause: "upstream" });
            dropUnitOperations(unit);
            console.warn(
              `[finalize-execution] dropped writes of ${root.runtimeId} for session ${sessionId}: ${error}`,
            );
            continue;
          }
          const lostReads = lostReadsOf(unit, prepared);
          if (lostReads.length > 0 && isolates(unit)) {
            const error = `read data of ${lostProducerName(lostReads[0]!)} that did not commit`;
            isolated.set(unit, { error, cause: "read" });
            dropUnitOperations(unit);
            console.warn(
              `[finalize-execution] dropped writes of ${root.runtimeId} for session ${sessionId}: ${error}`,
            );
            continue;
          }
          // A story or setup unit never drops for what it read: it
          // commits, and the trace says what it stood on.
          for (const lostRead of lostReads) {
            const { reader } = lostRead;
            await tx.addTraceEvent({
              id: crypto.randomUUID(),
              sessionId,
              type: "read-dependency.kept",
              traceId: emitter?.traceId ?? root.turnId,
              turnId: root.turnId,
              payload: {
                runtimeId: reader.runtimeId,
                runId: reader.runId,
                ...("operation" in lostRead
                  ? {
                      producerOperationId: lostRead.operation.record.id,
                      producerContract: lostRead.operation.record.contract,
                    }
                  : {
                      producerRuntimeId: lostRead.producer.runtimeId,
                      producerRunId: lostRead.producer.runId,
                    }),
                reason: `read data of ${lostProducerName(lostRead)} that did not commit`,
              },
              createdAt: new Date().toISOString(),
            });
          }
          const unitOperations = stagedOperationsOf(unit.members);
          // A unit with a story or setup run stays all-or-nothing with the
          // execution; any other unit gets one savepoint next to a story.
          if (!isolates(unit) || !tx.savepoint) {
            events.push(
              ...(await commitUnit(unit, tx, (fn) => postCommit.push(fn))),
            );
            // Story-attached operations: each one stands or drops alone,
            // and the story stands either way.
            const alone = hasStory && unit.members.some(protects);
            for (const entry of unitOperations) {
              args.signal?.throwIfAborted();
              if (!alone) {
                // Without a story the execution is all-or-nothing.
                events.push(
                  ...(await commitOperation(entry, tx, (fn) =>
                    postCommit.push(fn),
                  )),
                );
                settleOperation(entry, "committed");
                continue;
              }
              const preparedOperation = preparedOperations.get(entry)!;
              if (preparedOperation.failedProposals.length > 0) {
                failOperation(entry, preparedOperation.failedProposals);
                continue;
              }
              if (!tx.savepoint) {
                settleOperation(entry, "failed", "store-unsupported");
                console.warn(
                  `[finalize-execution] ${entry.record.contract} called by ${entry.member.runtimeId} was not committed: the store cannot isolate it next to the story`,
                );
                continue;
              }
              const buffered: Array<() => Promise<void>> = [];
              try {
                events.push(
                  ...(await tx.savepoint((sp) =>
                    commitOperation(entry, sp, (fn) => buffered.push(fn)),
                  )),
                );
                postCommit.push(...buffered);
                settleOperation(entry, "committed");
              } catch (err) {
                if (!(err instanceof ProposalCommitFailure)) throw err;
                failOperation(entry, err.failedProposals);
              }
            }
            continue;
          }
          const buffered: Array<() => Promise<void>> = [];
          // The operation that dropped the unit, when one did.
          let rejected: OperationEntry | undefined;
          try {
            events.push(
              ...(await tx.savepoint(async (sp) => {
                const committed = [
                  ...(await commitUnit(unit, sp, (fn) => buffered.push(fn))),
                ];
                for (const entry of unitOperations) {
                  args.signal?.throwIfAborted();
                  rejected = entry;
                  const commit = (sink: StoreTransaction) =>
                    commitOperation(entry, sink, (fn) => buffered.push(fn));
                  committed.push(
                    ...(await (sp.savepoint
                      ? sp.savepoint(commit)
                      : commit(sp))),
                  );
                  rejected = undefined;
                }
                return committed;
              })),
            );
            postCommit.push(...buffered);
            for (const entry of unitOperations)
              settleOperation(entry, "committed");
          } catch (err) {
            if (!(err instanceof ProposalCommitFailure)) throw err;
            isolatedFailures.push(...err.failedProposals);
            isolated.set(unit, {
              cause: "rejected",
              error:
                err.failedProposals.map((fp) => fp.error).join("; ") ||
                "proposal rejected",
            });
            dropUnitOperations(unit);
            if (rejected)
              settleOperation(
                rejected,
                "failed",
                operationFailureReason(err.failedProposals),
              );
            console.warn(
              `[finalize-execution] dropped writes of ${root.runtimeId} for session ${sessionId}: ` +
                err.failedProposals.map((fp) => fp.error).join("; "),
            );
          }
        }
        const dropped = droppedRuns();
        const droppedIds = droppedRootIds();
        const droppedRunIds = new Set([...dropped].map((run) => run.runId));
        const runDropped = (
          runId: string | undefined,
          runtimeId: string | undefined,
        ): boolean =>
          runId !== undefined
            ? droppedRunIds.has(runId)
            : runtimeId !== undefined && droppedIds.has(runtimeId);
        // Every narrative owes a settlement, whether or not a runtime of this
        // execution asked for its receipt.
        events.push(
          ...(await registerSettlements(tx, (fn) => postCommit.push(fn))),
        );
        // A dropped runtime settles as failed: like any failed run, it adds
        // nothing to the conversation and does not count as a trigger.
        for (const message of args.journalMessages ?? []) {
          if (
            runDropped(
              args.journalMessageRuns?.[message.id],
              message.sourceRuntimeId,
            )
          )
            continue;
          await tx.appendTurnMessage(message);
        }
        await extraInTx?.(tx, { droppedRuntimeIds: droppedIds });
        args.signal?.throwIfAborted();
        const rootView = {
          runtimes,
          results: units.map((unit) => unit.root),
          dropped: droppedIds,
        };
        await saveSuspensions(tx, (fn) => postCommit.push(fn), {
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
            (runtimeId, index) =>
              !runDropped(args.runtimeTriggerRuns?.[index], runtimeId),
          ),
          now: new Date().toISOString(),
        });
        await publishExports(
          tx,
          results.filter((result) => !dropped.has(result)),
        );
        // Persisted results were written before commit; settle dropped ones
        // as failed so history, retries and reloads match what was saved.
        const failedRuntimes = isolatedRuntimesOf(isolated);
        const settledOperations = settlementsOf(finalizedOperations());
        for (const turnId of turnIds) {
          await tx.setTurnResultCommitStatus(
            sessionId,
            turnId,
            "committed",
            failedRuntimes,
            settledOperations,
          );
        }
        args.signal?.throwIfAborted();
        return events;
      });
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
    return conclude({
      status: "committed",
      events: committedEvents,
      topLevelNarrativeMessageIds: committedEvents.flatMap((event) =>
        typeof event.payload.messageId === "string" &&
        topLevelNarrativeMessageIds.has(event.payload.messageId)
          ? [event.payload.messageId]
          : [],
      ),
      failedProposals: isolatedFailures,
      operations: finalizedOperations(),
      ...(fanOutFailed ? { fanOutFailed } : {}),
      ...(isolated.size > 0
        ? { isolatedRuntimes: isolatedRuntimesOf(isolated) }
        : {}),
    });
  });
}
