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
import { runWithHookScope } from "../hooks/hook-scope.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import { processRuntimeResult } from "../session/session-runtime-result.js";
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
import {
  publishExecutionExports,
  type ExportDecl,
} from "./runtime-export-publish.js";
import {
  canonicalizeMediaRefs,
  type MediaOwnershipStore,
} from "../media/canonicalize-media-refs.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { storyOutputError } from "../agent-loop/story-output.js";

/**
 * The subset of a manifest needed to resolve output kind, capabilities, scope
 * and the persistent `recordAs` export (docs 02 §3.4). `output.recordAs` and
 * `version` come free from the manifest, so callers keep passing their active
 * runtimes unchanged; the export VALUE's schema is loaded lazily via
 * `loadOutputSchema` (below) only when a success result actually needs it.
 */
type FinalizeManifest = Pick<
  RuntimeManifest,
  "name" | "pluginId" | "outputKind" | "capabilities" | "version" | "output"
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
  /** Canonical identity of the execution being finalized. */
  readonly executionContext: ExecutionContext;
  /**
   * Manifests for every runtime that may appear in `results`, used to resolve
   * each result's `outputKind` / `capabilities` and (by default) the hook
   * scope. Callers pass the session's active runtimes.
   */
  readonly runtimes: readonly FinalizeManifest[];
  /** Flattened results to commit: top-level plus nested recursiveCall results. */
  readonly results: readonly FinalizableResult[];
  /** Conversation entries committed atomically with this execution. */
  readonly journalMessages?: readonly TurnMessageRecord[];
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
  /**
   * Caller-specific writes folded into the same transaction, run after every
   * result commits and before `commit_status` settles. Resume uses it for the
   * assistant turn message + resolved marker. A throw rolls the execution back.
   */
  readonly extraInTx?: (tx: StoreTransaction) => Promise<void>;
  /**
   * Session-clock write folded into the same transaction: logical-turn
   * counting (from `executionContext`) plus the setup-band mirror / phase flip
   * (from `setupCompletion`). Only the player action path supplies it; manual /
   * background / resume finalizes omit it and leave the clock untouched. A
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
   * the commit transaction (docs 02 §3.4). Absent ⇒ no export publication: thin
   * callers (resume, tests) that do not thread a loader publish nothing.
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
  status: "committed" | "failed",
): Promise<void> {
  const scopeId = args.executionContext?.executionId;
  if (!scopeId) return;
  try {
    const reported = await args.store.listJobStatus(args.sessionId, {
      progressScopeId: scopeId,
    });
    if (reported.length === 0) return;
    const statusByRuntime = new Map(
      args.results.map((result) => [result.runtimeId, result.status]),
    );
    const groups = new Map<
      string,
      { pluginId: string; runtimeId: string; jobIds: Set<string> }
    >();
    for (const record of reported) {
      const key = `${record.pluginId} ${record.runtimeId}`;
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
  const capabilitiesByRuntime = new Map<string, readonly string[]>();
  for (const rt of runtimes) {
    outputKindByRuntime.set(rt.name, rt.outputKind ?? "plugin");
    capabilitiesByRuntime.set(rt.name, rt.capabilities ?? []);
  }
  const activePluginIds =
    args.activePluginIds ?? new Set(runtimes.map((rt) => rt.pluginId));

  // Per-runtime `recordAs` export declaration (docs 02 §3.4). Only present when
  // a loader was threaded — resume / thin callers publish no exports this wave.
  const exportDeclByRuntime = new Map<string, ExportDecl>();
  if (args.loadOutputSchema) {
    for (const rt of runtimes) {
      const recordAs = rt.output?.recordAs;
      if (!recordAs) continue;
      exportDeclByRuntime.set(rt.name, {
        recordAs,
        pluginId: rt.pluginId,
        pluginVersion: rt.version ?? "0.0.0",
      });
    }
  }
  const publishExports = async (
    sink: Parameters<typeof publishExecutionExports>[0]["sink"],
  ): Promise<void> => {
    if (!args.loadOutputSchema || exportDeclByRuntime.size === 0) return;
    const mediaStore = args.mediaStore;
    await publishExecutionExports({
      sink,
      sessionId,
      results,
      declFor: (runtimeId) => exportDeclByRuntime.get(runtimeId),
      loadOutputSchema: args.loadOutputSchema,
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

  const processOpts = (
    result: FinalizableResult,
    deferPostCommit?: (fn: () => Promise<void>) => void,
  ) => ({
    ...(hookPipeline ? { hookPipeline } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(emitter ? { emitter } : {}),
    capabilities: capabilitiesByRuntime.get(result.runtimeId) ?? [],
    ...(args.proposalGuard ? { proposalGuard: args.proposalGuard } : {}),
    ...(deferPostCommit ? { deferPostCommit } : {}),
  });
  const kindOf = (result: FinalizableResult): string =>
    outputKindByRuntime.get(result.runtimeId) ?? "plugin";

  // Every exit funnels through here so reported jobs always reach a terminal
  // state, whatever the domain outcome.
  const conclude = async (
    outcome: FinalizeExecutionOutcome,
  ): Promise<FinalizeExecutionOutcome> => {
    await terminalizeExecutionJobs(args, outcome.status);
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
  return runWithHookScope({ activePluginIds }, async () => {
    // Externally-visible fan-out is buffered while the transaction is open and
    // flushed only after it commits. A rollback discards the buffer.
    const postCommit: Array<() => Promise<void>> = [];
    let committedEvents: readonly SessionEvent[] = [];
    try {
      committedEvents = await store.withTransaction(async (tx) => {
        // A failed story cannot complete a player action. Optional state
        // extractors may fail independently after a valid narrative exists.
        for (const result of results) {
          if (kindOf(result) !== "story") continue;
          const error =
            result.status === "failed"
              ? `Story runtime ${result.runtimeId} failed; the action was not committed.`
              : result.status === "success"
                ? storyOutputError(result.output)
                : undefined;
          if (error) throw new Error(error);
        }
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
            throw new ProposalCommitFailure(out.failedProposals);
          }
        }
        for (const message of args.journalMessages ?? []) {
          await tx.appendTurnMessage(message);
        }
        await extraInTx?.(tx);
        await saveSuspensions(tx, (fn) => postCommit.push(fn));
        if (shouldWriteClock) {
          await applySessionClockTx(tx, {
            sessionId,
            executionContext,
            update: sessionClock!,
          });
        }
        await publishExports(tx);
        for (const turnId of turnIds) {
          await tx.setTurnResultCommitStatus(sessionId, turnId, "committed");
        }
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
    return conclude({
      status: "committed",
      events: committedEvents,
      failedProposals: [],
    });
  });
}
