/**
 * Preparing and committing an execution's units.
 *
 * Each unit's writes are prepared before the transaction opens. In the
 * transaction the units commit in execution order. A unit whose hard upstream
 * was dropped, or that read uncommitted data of a dropped producer, is dropped
 * too when it may be dropped alone (`commit-isolation.ts`). A unit with a
 * story or setup run, and every unit of an execution without a story, commits
 * with the execution: a rejected write rolls everything back, except that a
 * story-attached operation stands or drops alone. Any other unit next to a
 * story commits in its own savepoint and drops alone, with its operations.
 */

import type { StoreTransaction } from "@covel/store";
import type { Proposal, RuntimeManifest, SessionEvent } from "@covel/shared";
import { isPublicStoryRuntime } from "@covel/shared/contracts";
import { createDisplayMessageBuffer } from "./display-message-buffer.js";
import {
  checkPendingReadBaselines,
  readScopesOf,
  stampReadPreconditions,
  withoutReadPreconditions,
} from "../read-baselines.js";
import {
  presentationMutationError,
  presentationSuperseded,
} from "../presentation/commit.js";
import { presentationState } from "../presentation/state.js";
import { turnStory } from "../presentation/turn-story.js";
import { nestedResultProposals } from "../resume/suspension-baseline.js";
import {
  commitPreparedProposals,
  prepareOperationProposals,
  prepareRuntimeProposals,
  type FailedProposal,
  type PreparedRuntimeProposals,
} from "../session/session-runtime-result.js";
import {
  adoptRetryReadSets,
  needsSettlementReceipt,
  registerDimensionSettlements,
  type DimensionSettlementScope,
} from "./dimension-finalization.js";
import {
  lostProducerName,
  unitDependencies,
  type CommitUnit,
  type DroppedUnits,
  type IsolationPolicy,
  type LostRead,
} from "./commit-isolation.js";
import {
  asOperationFailures,
  operationFailureReason,
  type OperationEntry,
  type OperationLedger,
} from "./operation-ledger.js";
import type { CommitOptions } from "./commit-options.js";
import type {
  FinalizableResult,
  FinalizeExecutionArgs,
} from "./finalize-types.js";

type DeferPostCommit = (fn: () => Promise<void>) => void;

/** Carries the failed proposals out of the transaction callback for the caller. */
export class ProposalCommitFailure extends Error {
  constructor(readonly failedProposals: readonly FailedProposal[]) {
    super(`${failedProposals.length} proposal(s) failed to commit`);
    this.failedProposals = failedProposals.map((failure) => ({
      ...failure,
      proposal: withoutReadPreconditions(
        failure.proposal,
      ) as typeof failure.proposal,
    }));
    this.name = "ProposalCommitFailure";
  }
}

export interface PreparedCommit {
  readonly prepared: ReadonlyMap<FinalizableResult, PreparedRuntimeProposals>;
  readonly preparedOperations: ReadonlyMap<
    OperationEntry,
    PreparedRuntimeProposals
  >;
}

/**
 * Normalization, guards and PreStateCommit hooks run before the
 * transaction: hooks are plugin code with their own timeouts and must
 * never hold the store's write gate. The transaction then only writes.
 */
export async function prepareCommit(
  args: FinalizeExecutionArgs,
  options: CommitOptions,
  ledger: OperationLedger,
): Promise<PreparedCommit> {
  const { store, sessionId, results } = args;
  const preparedOperations = new Map<
    OperationEntry,
    PreparedRuntimeProposals
  >();
  const prepared = new Map<FinalizableResult, PreparedRuntimeProposals>();
  for (const result of results) {
    args.signal?.throwIfAborted();
    prepared.set(
      result,
      await prepareRuntimeProposals(
        result,
        store,
        sessionId,
        options.kindOf(result),
        {
          ...options.forResult(result),
          readScopes:
            args.readBaselines?.runs[result.runId] ?? readScopesOf(result),
        },
      ),
    );
    // A run's operations are prepared after its own writes.
    for (const entry of ledger.stagedOf([result])) {
      args.signal?.throwIfAborted();
      preparedOperations.set(
        entry,
        await prepareOperationProposals(entry.writes, {
          ...options.forOperation(entry),
          readScopes: args.readBaselines?.operations[entry.record.id] ?? [],
        }),
      );
    }
  }
  return { prepared, preparedOperations };
}

/** What committing the units reads, and what it records for the outcome. */
export interface UnitCommitContext extends PreparedCommit {
  readonly args: FinalizeExecutionArgs;
  readonly options: CommitOptions;
  readonly ledger: OperationLedger;
  readonly policy: IsolationPolicy;
  readonly units: readonly CommitUnit[];
  /** Dropped unit -> why its writes were dropped. */
  readonly drops: DroppedUnits;
  /**
   * Externally-visible fan-out, buffered while the transaction is open and
   * flushed only after it commits. A rollback discards the buffer.
   */
  readonly postCommit: (() => Promise<void>)[];
  /** Rejected writes of the runs and operations dropped alone. */
  readonly isolatedFailures: FailedProposal[];
  readonly operationFailureMessages: { messageId: string; count: number }[];
  /** Public story messages top-level runs wrote, with each one's runtime. */
  readonly topLevelStories: Map<string, RuntimeManifest>;
  readonly tx: StoreTransaction;
  /** Events of the committed proposals, in commit order. */
  readonly events: SessionEvent[];
  /** Public story messages by id, with the result that wrote each. */
  readonly narrativeOwners: Map<string, FinalizableResult>;
  readonly dimensions: DimensionSettlementScope | undefined;
  /** A manual run that repairs the content of an earlier turn. */
  readonly scopedRetry: boolean;
}

/**
 * Settlement receipts freeze committed records. They are registered
 * where a runtime first needs one and again after the last runtime, so
 * a receipt never describes initialization that was vetoed, rewritten
 * or rolled back with its runtime.
 */
export async function registerSettlements(
  ctx: Pick<UnitCommitContext, "args" | "dimensions">,
  sink: StoreTransaction,
  defer: DeferPostCommit,
): Promise<readonly SessionEvent[]> {
  const { dimensions } = ctx;
  const { sessionId, runtimes, results, emitter, eventBus } = ctx.args;
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
      await emitter?.emit("dimensions.settlement.changed", event.payload);
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
}

async function commitResult(
  ctx: UnitCommitContext,
  result: FinalizableResult,
  sink: StoreTransaction,
  defer: DeferPostCommit,
  scope: "top-level" | "nested",
): Promise<readonly SessionEvent[]> {
  const { args, dimensions } = ctx;
  const { sessionId } = args;
  const { proposals, failedProposals } = ctx.prepared.get(result)!;
  // Pending calculations keep their read-time basis; suspension-time
  // write digests cannot certify a calculation that was already stale.
  for (const suspension of args.suspensions ?? []) {
    if (args.suspensionRuns?.[suspension.id] !== result.runId) continue;
    const continuation = suspension.pendingContinuation;
    const nested = (continuation.nestedResults ?? []).flatMap((entry) =>
      stampReadPreconditions(
        nestedResultProposals([entry], sessionId),
        entry.readScopes ?? [],
      ),
    );
    const pending = (continuation.pendingProposals as readonly Proposal[]).map(
      (proposal) =>
        ({
          ...withoutReadPreconditions(proposal),
          sessionId,
          source: {
            pluginId: suspension.pluginId,
            runtimeId: suspension.runtimeId,
          },
        }) as Proposal,
    );
    const failure = await checkPendingReadBaselines(sink, [
      ...nested,
      ...stampReadPreconditions(pending, continuation.readScopes ?? []),
    ]);
    if (failure) throw new ProposalCommitFailure([failure]);
  }
  const presentationSource = presentationState(result);
  if (presentationSource && failedProposals.length)
    throw new ProposalCommitFailure(failedProposals);
  if (
    presentationSource &&
    !presentationSource.snapshot.committed &&
    !turnStory(ctx.topLevelStories.values(), (runtime) => runtime)
  ) {
    presentationSource.reason = "no-story";
    return [];
  }
  if (await presentationSuperseded(sink, sessionId, result, proposals))
    return [];
  const presentationError = await presentationMutationError(
    sink,
    sessionId,
    result,
    proposals,
  );
  if (presentationError)
    throw new ProposalCommitFailure(
      proposals.map((proposal) => ({
        proposal,
        error: presentationError,
      })),
    );
  const committed: SessionEvent[] = [];
  const failed = [...failedProposals];
  const commitBatch = async (batch: readonly Proposal[]): Promise<void> => {
    if (batch.length === 0) return;
    const out = await commitPreparedProposals(batch, sink, sessionId, result, {
      ...ctx.options.forResult(result, defer),
      storySource: {
        executionId: args.executionContext.executionId,
        runId: result.runId,
        pluginId: result.pluginId,
        runtimeId: result.runtimeId,
        scope,
      },
    });
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
    committed.push(...(await registerSettlements(ctx, sink, defer)));
    const updates = proposals.slice(settles);
    if (ctx.scopedRetry && result.status === "success")
      await adoptRetryReadSets({
        sink,
        sessionId,
        scope: dimensions,
        proposals: updates,
      });
    await commitBatch(updates);
  }
  if (failed.length > 0) throw new ProposalCommitFailure(failed);
  const presentation = presentationState(result);
  if (presentation) presentation.committedWrites = proposals.length;
  return committed;
}

// A unit's results commit children first, then the parent; units
// arrive in execution order, so every upstream settles before the
// runtimes that depend on it.
async function commitUnit(
  ctx: UnitCommitContext,
  unit: CommitUnit,
  sink: StoreTransaction,
  defer: DeferPostCommit,
): Promise<readonly SessionEvent[]> {
  const { args, narrativeOwners, topLevelStories } = ctx;
  const { runtimes } = args;
  const committed: SessionEvent[] = [];
  for (const member of unit.members) {
    args.signal?.throwIfAborted();
    const memberEvents = await commitResult(
      ctx,
      member,
      sink,
      defer,
      member === unit.root ? "top-level" : "nested",
    );
    committed.push(...memberEvents);
    const manifest = runtimes.find(
      (runtime) =>
        runtime.name === member.runtimeId &&
        runtime.pluginId === member.pluginId,
    );
    if (!manifest || !isPublicStoryRuntime(manifest)) continue;
    for (const event of memberEvents) {
      if (
        event.type === "narrative.completed" &&
        event.payload.kind === "story" &&
        typeof event.payload.messageId === "string"
      ) {
        narrativeOwners.set(event.payload.messageId, member);
        // Only a top-level story can speak for the turn (auto-advance,
        // presentation); nested story output belongs to its caller.
        if (member === unit.root)
          topLevelStories.set(event.payload.messageId, manifest);
      }
    }
  }
  return committed;
}

// One operation's writes, after its unit's own writes. Any refusal
// fails the whole operation; an `update` that no longer applies is
// a conflict.
async function commitOperation(
  ctx: UnitCommitContext,
  entry: OperationEntry,
  sink: StoreTransaction,
  defer: DeferPostCommit,
): Promise<readonly SessionEvent[]> {
  const { proposals, failedProposals } = ctx.preparedOperations.get(entry)!;
  if (failedProposals.length > 0)
    throw new ProposalCommitFailure(failedProposals);
  const out = await commitPreparedProposals(
    proposals,
    sink,
    ctx.args.sessionId,
    {
      runtimeId: `service:${entry.record.service}`,
      turnId: entry.member.turnId,
    },
    ctx.options.forOperation(entry, defer),
  );
  if (out.failedProposals.length > 0)
    throw new ProposalCommitFailure(asOperationFailures(out.failedProposals));
  return out.events;
}

// A story-attached operation that did not land: only it is dropped.
function failOperation(
  ctx: UnitCommitContext,
  entry: OperationEntry,
  failed: readonly FailedProposal[],
): void {
  ctx.isolatedFailures.push(
    ...failed.map((item) => ({
      ...item,
      proposal: withoutReadPreconditions(item.proposal) as typeof item.proposal,
      operationId: entry.record.id,
    })),
  );
  ctx.ledger.settle(entry, "failed", operationFailureReason(failed));
  console.warn(
    `[finalize-execution] ${entry.record.contract} called by ${entry.member.runtimeId} did not commit for session ${ctx.args.sessionId}: ` +
      failed.map((fp) => fp.error).join("; "),
  );
}

function dropUnitOperations(ctx: UnitCommitContext, unit: CommitUnit): void {
  for (const entry of ctx.ledger.stagedOf(unit.members))
    ctx.ledger.settle(entry, "discarded", "caller-dropped");
}

/** Commit every unit in execution order, or drop the ones that must drop. */
export async function commitUnitsInOrder(
  ctx: UnitCommitContext,
): Promise<void> {
  const { args, tx, ledger, policy, drops } = ctx;
  const { sessionId } = args;
  const dependencies = unitDependencies({
    runtimes: args.runtimes,
    results: args.results,
    units: ctx.units,
    prepared: ctx.prepared,
    readDependencies: args.readDependencies,
    suspensionRuns: args.suspensionRuns,
    operations: ledger,
    drops,
  });
  for (const unit of ctx.units) {
    args.signal?.throwIfAborted();
    const { root } = unit;
    const lostUpstream = dependencies.lostUpstreamOf(unit);
    if (lostUpstream) {
      const error = `upstream ${lostUpstream} did not commit`;
      // A story or setup runtime cannot stand on writes that did not land.
      if (!policy.isolates(unit)) {
        throw new Error(`${root.runtimeId}: ${error}`);
      }
      drops.drop(unit, { error, cause: "upstream" });
      dropUnitOperations(ctx, unit);
      console.warn(
        `[finalize-execution] dropped writes of ${root.runtimeId} for session ${sessionId}: ${error}`,
      );
      continue;
    }
    const lostReads = dependencies.lostReadsOf(unit);
    if (lostReads.length > 0 && policy.isolates(unit)) {
      const error = `read data of ${lostProducerName(lostReads[0]!)} that did not commit`;
      drops.drop(unit, { error, cause: "read" });
      dropUnitOperations(ctx, unit);
      console.warn(
        `[finalize-execution] dropped writes of ${root.runtimeId} for session ${sessionId}: ${error}`,
      );
      continue;
    }
    // A story or setup unit never drops for what it read: it
    // commits, and the trace says what it stood on.
    await traceKeptReads(ctx, root, lostReads);
    const unitOperations = ledger.stagedOf(unit.members);
    // A unit with a story or setup run stays all-or-nothing with the
    // execution; any other unit gets one savepoint next to a story.
    if (!policy.isolates(unit) || !tx.savepoint) {
      await commitWithExecution(ctx, unit, unitOperations);
      continue;
    }
    await commitInSavepoint(ctx, unit, unitOperations);
  }
}

async function traceKeptReads(
  ctx: UnitCommitContext,
  root: FinalizableResult,
  lostReads: readonly LostRead[],
): Promise<void> {
  const { tx, args } = ctx;
  for (const lostRead of lostReads) {
    const { reader } = lostRead;
    await tx.addTraceEvent({
      id: crypto.randomUUID(),
      sessionId: args.sessionId,
      type: "read-dependency.kept",
      traceId: args.emitter?.traceId ?? root.turnId,
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
}

/**
 * A unit that commits with the execution, next to a story or not. Its
 * display rows are inserted once its operations settled, with a notice of
 * the ones that failed on its story.
 */
async function commitWithExecution(
  ctx: UnitCommitContext,
  unit: CommitUnit,
  unitOperations: readonly OperationEntry[],
): Promise<void> {
  const { args, tx, ledger, policy, events, postCommit } = ctx;
  const display = createDisplayMessageBuffer(tx);
  events.push(
    ...(await commitUnit(ctx, unit, display.store, (fn) =>
      postCommit.push(fn),
    )),
  );
  // Story-attached operations: each one stands or drops alone,
  // and the story stands either way.
  const alone = policy.hasStory && unit.members.some(policy.protects);
  for (const entry of unitOperations) {
    args.signal?.throwIfAborted();
    if (!alone) {
      // Without a story the execution is all-or-nothing.
      events.push(
        ...(await commitOperation(ctx, entry, display.store, (fn) =>
          postCommit.push(fn),
        )),
      );
      ledger.settle(entry, "committed");
      continue;
    }
    const preparedOperation = ctx.preparedOperations.get(entry)!;
    if (preparedOperation.failedProposals.length > 0) {
      failOperation(ctx, entry, preparedOperation.failedProposals);
      continue;
    }
    if (!tx.savepoint) {
      ledger.settle(entry, "failed", "store-unsupported");
      console.warn(
        `[finalize-execution] ${entry.record.contract} called by ${entry.member.runtimeId} was not committed: the store cannot isolate it next to the story`,
      );
      continue;
    }
    const buffered: Array<() => Promise<void>> = [];
    try {
      events.push(
        ...(await display.store.savepoint!((sp) =>
          commitOperation(ctx, entry, sp, (fn) => buffered.push(fn)),
        )),
      );
      postCommit.push(...buffered);
      ledger.settle(entry, "committed");
    } catch (err) {
      if (!(err instanceof ProposalCommitFailure)) throw err;
      failOperation(ctx, entry, err.failedProposals);
    }
  }
  // Count by carrying result/unit, never by invokedBy (a child may
  // have made the call). Prefer the root's last accepted public story.
  const members = new Set(unit.members);
  const candidates = [...ctx.narrativeOwners].filter(([, owner]) =>
    members.has(owner),
  );
  const target =
    candidates.filter(([, owner]) => owner === unit.root).at(-1) ??
    candidates.at(-1);
  const count = new Set(
    ledger.entries
      .filter(
        (entry) =>
          members.has(entry.member) && ledger.statusOf(entry) === "failed",
      )
      .map((entry) => entry.record.id),
  ).size;
  const notice =
    target && count > 0 ? { messageId: target[0], count } : undefined;
  await display.flush(notice);
  if (notice) ctx.operationFailureMessages.push(notice);
}

/**
 * An optional unit next to a story, in one savepoint with each of its
 * operations nested in its own: a rejected write drops the unit alone.
 */
async function commitInSavepoint(
  ctx: UnitCommitContext,
  unit: CommitUnit,
  unitOperations: readonly OperationEntry[],
): Promise<void> {
  const { args, tx, ledger, drops, events, postCommit } = ctx;
  const buffered: Array<() => Promise<void>> = [];
  // The operation that dropped the unit, when one did.
  let rejected: OperationEntry | undefined;
  try {
    events.push(
      ...(await tx.savepoint!(async (sp) => {
        const committed = [
          ...(await commitUnit(ctx, unit, sp, (fn) => buffered.push(fn))),
        ];
        for (const entry of unitOperations) {
          args.signal?.throwIfAborted();
          rejected = entry;
          const commit = (sink: StoreTransaction) =>
            commitOperation(ctx, entry, sink, (fn) => buffered.push(fn));
          committed.push(
            ...(await (sp.savepoint ? sp.savepoint(commit) : commit(sp))),
          );
          rejected = undefined;
        }
        return committed;
      })),
    );
    postCommit.push(...buffered);
    for (const entry of unitOperations) ledger.settle(entry, "committed");
  } catch (err) {
    if (!(err instanceof ProposalCommitFailure)) throw err;
    ctx.isolatedFailures.push(...err.failedProposals);
    drops.drop(unit, {
      cause: "rejected",
      error:
        err.failedProposals.map((fp) => fp.error).join("; ") ||
        "proposal rejected",
    });
    dropUnitOperations(ctx, unit);
    if (rejected)
      ledger.settle(
        rejected,
        "failed",
        operationFailureReason(err.failedProposals),
      );
    console.warn(
      `[finalize-execution] dropped writes of ${unit.root.runtimeId} for session ${args.sessionId}: ` +
        err.failedProposals.map((fp) => fp.error).join("; "),
    );
  }
}
