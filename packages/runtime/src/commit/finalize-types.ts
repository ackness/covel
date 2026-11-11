/**
 * The contract of `finalizeExecution`: what a host hands it and what it
 * returns. `finalize-execution.ts` re-exports the public types; the commit
 * modules import them from here, so none of them imports the wiring module.
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
  OperationStatus,
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  SessionEvent,
} from "@covel/shared";
import type { HookPipeline } from "../hooks/pipeline.js";
import type { HookScope } from "../hooks/hook-scope.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import type {
  CommittableRuntimeResult,
  FailedProposal,
} from "../session/session-runtime-result.js";
import type { ProviderDatasets } from "../operations/operation-stage.js";
import type { SessionClockUpdate } from "./session-clock.js";
import type { RanSetupRuntime } from "./setup-settle.js";
import type { MediaOwnershipStore } from "../media/canonicalize-media-refs.js";
import type { SavedLifecycleDeps } from "../resume/suspended-lifecycle.js";
import type { DatasetSchemas } from "../plugin-data-validation.js";
import type { ExecutionReadBaselines } from "../read-baselines.js";
import type { PresentationState } from "../presentation/state.js";
import type { ExecutionEventDependencies } from "../event-dependencies.js";

/**
 * Manifests resolve output kind, capabilities, scope, the persistent
 * `recordAs` export (docs 02 §3.4) and, for savepoint isolation, the hard
 * dependencies between runtimes. Callers pass their active runtimes; the
 * export VALUE's schema is loaded lazily via `loadOutputSchema` (below) only
 * when a success result actually needs it.
 */
type FinalizeManifest = RuntimeManifest;

/** Commit results retain the execution identity and status of a runtime result. */
export type FinalizableResult = CommittableRuntimeResult &
  Pick<RuntimeResult, "runId" | "status" | "operations" | "operationWrites">;

export interface FinalizeExecutionArgs {
  /** Host-only receipts retained across the immutable commit-plan clone. */
  readonly presentationStates?: ReadonlyMap<string, PresentationState>;
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
   * there. A failed attempt fails its owned tasks while retaining the
   * suspension and buffered writes for retry.
   */
  readonly progressScopeId?: string;
  readonly progressAttemptId?: string;
  readonly resumedSuspension?: SuspensionRecord;
  readonly onRuntimeCorrection?: SavedLifecycleDeps["onRuntimeCorrection"];
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
  readonly readBaselines?: ExecutionReadBaselines;
  readonly readDependencies?: Readonly<Record<string, readonly string[]>>;
  /** Actual payload producers, captured by the event chain, never inferred by topic. */
  readonly eventDependencies?: ExecutionEventDependencies;
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
  /** Safe receipts authored with display rows, returned only after commit. */
  readonly operationFailureMessages?: readonly {
    readonly messageId: string;
    readonly count: number;
  }[];
  /**
   * Internal provenance receipt: the committed story messages that speak for
   * the turn (`turnStoryCandidates`). Auto-advance follows the one there is.
   */
  readonly turnStoryMessageIds?: readonly string[];
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
  /** Every dropped invocation, including nested runs with repeated runtime IDs. */
  readonly droppedRunIds: ReadonlySet<string>;
  /** Actual source run IDs, paired by position with the execution's followers. */
  readonly followerSources: readonly string[];
}
