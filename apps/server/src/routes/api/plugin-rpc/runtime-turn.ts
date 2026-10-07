import {
  DIMENSION_DATA_NAMESPACE,
  concealedRuntimeIds,
  dimensionRecordSchema,
} from "@covel/shared";
import { commitExecution } from "../commit-execution.js";
import {
  createTurnEmitter,
  createDetachedProposalGuard,
  executeTurn,
  buildHookSettings,
  snapshotUserSettings,
  type HookScope,
  type TurnExecutorDeps,
} from "@covel/runtime";
import type { DataStore, SessionRecord, StoreTransaction } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import type {
  DeferredRuntimeJob,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";

import {
  withBackgroundSessionLock,
  type SessionLock,
} from "../../../lib/session-lock.js";
import type {
  ManualTurnSummary,
  TurnCommitOutcome,
} from "./runtime-response.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../session/session-guard.js";
import { buildSessionHookScope } from "../session/hook-scope.js";
import { listSettlingRuntimeJobs } from "./jobs.js";
import type { SettleWaitBudget } from "./settled-session-lock.js";

export class SessionApprovalScopeChangedError extends Error {
  constructor() {
    super("approval scope changed while the runtime request was waiting");
    this.name = "SessionApprovalScopeChangedError";
  }
}

export class SessionNotActiveError extends Error {
  constructor(readonly status: string) {
    super(`session is ${status}; runtime execution refused`);
    this.name = "SessionNotActiveError";
  }
}

export interface PluginRpcRuntimeTurnContext {
  readonly memorySystem?: import("@covel/memory").MemorySystem;
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly sessionLock: SessionLock;
  readonly resolveImageFlowRuntimeIds?: () => Promise<
    readonly string[] | undefined
  >;
  readonly withSettledLock?: <T>(
    fn: () => Promise<T>,
    waitBudget?: SettleWaitBudget,
  ) => Promise<T>;
  readonly withSnapshot?: <T>(
    fn: () => Promise<T>,
    /** Runs under the session lock immediately before artifact capture. */
    beforeCapture?: () => Promise<void>,
  ) => Promise<T>;
  readonly sessionId: string;
  readonly session: Pick<SessionRecord, "locale" | "runtimeModelOverrides">;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly pluginRegistry?: PluginRegistry;
  /** Capability incarnation captured for every runtime plugin in this graph. */
  readonly approvalScopes: ReadonlyMap<string, string>;
  readonly deps: Omit<TurnExecutorDeps, "store" | "eventBus" | "emitter">;
  readonly hookPipeline?: TurnExecutorDeps["hookPipeline"];
}

/**
 * Durable-worker hooks for a queued run: admission and commit barriers, and a
 * write that settles the job in the same transaction as the domain commit.
 */
export interface QueuedRunControl {
  readonly expectedSessionIncarnation?: string;
  readonly beforeExecute?: () => Promise<void>;
  readonly beforeCommit?: (args: {
    readonly backgroundTurnId: string;
    readonly backgroundExecutionId: string;
  }) => Promise<void>;
}

export interface RunManualTurnArgs extends QueuedRunControl {
  readonly executionSignal?: AbortSignal;
  readonly turnId: string;
  readonly runtimeId: string;
  readonly payload?: unknown;
  /**
   * Retry seeding: recorded runtime results of the original turn, threaded
   * into `TurnInput.manualTrigger.retrySeedResults` so the executor resolves
   * the target's inject/needs against them.
   */
  readonly retrySeedResults?: readonly RuntimeResult[];
  readonly sourceTurnId?: string;
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  /**
   * Run the runtime outside the session lock, committing under it — set for
   * `execution: background`, which has already detached from the request and
   * may run for minutes. Sync callers leave it unset: they await the response
   * and are short enough that holding the lock throughout costs nothing.
   */
  readonly detached?: boolean;
  /** Runs inside the commit transaction, in both modes. */
  readonly completeInTx?: (
    tx: StoreTransaction,
    result: import("@covel/shared").TurnResult,
  ) => Promise<void>;
}

export interface RunDeferredFollowerArgs extends QueuedRunControl {
  readonly executionSignal?: AbortSignal;
  readonly followerTurnId: string;
  readonly runtimeId: string;
  readonly triggerEvent: {
    readonly topic: string;
    readonly data: Readonly<Record<string, unknown>>;
  };
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly completeInTx?: (
    tx: StoreTransaction,
    result: import("@covel/shared").TurnResult,
  ) => Promise<void>;
}

export interface RunDetachedStageArgs {
  readonly descriptor: DeferredRuntimeJob;
  readonly backgroundTurnId: string;
  readonly expectedSessionIncarnation: string;
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly modelOverride?: string;
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
  readonly beforeCommit: (args: {
    readonly backgroundTurnId: string;
    readonly backgroundExecutionId: string;
  }) => Promise<void>;
  readonly completeInTx: (
    tx: StoreTransaction,
    result: import("@covel/shared").TurnResult,
  ) => Promise<void>;
  readonly beforeExecute?: () => Promise<void>;
  readonly executionSignal?: AbortSignal;
}

/**
 * Stable cross-process identity for detached work owned by one runtime.
 *
 * Runtime handlers commonly perform read-check-generate-write sequences over
 * plugin data. Until those domain writes expose their own atomic idempotency
 * keys, every activation of the same runtime must stay serialised; otherwise
 * different payloads can still target the same record and overwrite each
 * other after both have paid for provider work.
 */
export function backgroundRuntimeLockId(
  sessionId: string,
  runtimeId: string,
): string {
  return `background-runtime:${JSON.stringify([sessionId, runtimeId])}`;
}

function queuedRunOptions(control: QueuedRunControl): QueuedRunControl {
  return {
    ...(control.expectedSessionIncarnation
      ? { expectedSessionIncarnation: control.expectedSessionIncarnation }
      : {}),
    ...(control.beforeExecute ? { beforeExecute: control.beforeExecute } : {}),
    ...(control.beforeCommit ? { beforeCommit: control.beforeCommit } : {}),
  };
}

export function createPluginRpcRuntimeTurnRunner(
  ctx: PluginRpcRuntimeTurnContext,
): {
  runManualTurn(args: RunManualTurnArgs): Promise<ManualTurnSummary>;
  runDeferredFollowerTurn(args: RunDeferredFollowerArgs): Promise<{
    readonly turnResult: import("@covel/shared").TurnResult;
    readonly commit: TurnCommitOutcome;
  }>;
  runDetachedStage(args: RunDetachedStageArgs): Promise<{
    readonly turnResult: import("@covel/shared").TurnResult;
    readonly commit: TurnCommitOutcome;
  }>;
} {
  function activeRuntimes(): readonly RuntimeManifest[] {
    return (
      ctx.pluginRegistry?.getActiveRuntimes(ctx.sessionId) ?? ctx.activeRuntimes
    );
  }

  async function withSnapshot<T>(
    fn: () => Promise<T>,
    beforeCapture?: () => Promise<void>,
  ): Promise<T> {
    if (ctx.withSnapshot) return ctx.withSnapshot(fn, beforeCapture);
    if (beforeCapture)
      await ctx.sessionLock.withLock(ctx.sessionId, beforeCapture);
    return fn();
  }

  function executionControl(
    signal?: AbortSignal,
  ): TurnExecutorDeps["turnControl"] {
    const current = ctx.deps.turnControl;
    return signal
      ? {
          ...current,
          executionSignal: current?.executionSignal
            ? AbortSignal.any([current.executionSignal, signal])
            : signal,
        }
      : current;
  }

  function assertApprovalScope(
    session: SessionRecord,
    runtimeId: string,
  ): void {
    const pluginId = activeRuntimes().find(
      (runtime) => runtime.name === runtimeId,
    )?.pluginId;
    const expected = pluginId ? ctx.approvalScopes.get(pluginId) : undefined;
    if (
      !pluginId ||
      !expected ||
      sessionApprovalScope(session, pluginId) !== expected
    ) {
      throw new SessionApprovalScopeChangedError();
    }
  }

  async function requireLiveApprovedSession(
    runtimeId: string,
  ): Promise<SessionRecord> {
    const live = await ctx.store.getSession(ctx.sessionId);
    if (!live) {
      throw new SessionNotActiveError("deleted");
    }
    if (live.status !== "active") {
      throw new SessionNotActiveError(live.status);
    }
    assertApprovalScope(live, runtimeId);
    return live;
  }

  function hookScopeFor(
    activePluginIds: readonly string[],
    userSettings: Parameters<typeof snapshotUserSettings>[0],
  ): HookScope {
    if (!ctx.pluginRegistry) {
      return {
        activePluginIds: new Set(
          activeRuntimes().map((runtime) => runtime.pluginId),
        ),
        settings: buildHookSettings(activeRuntimes(), userSettings),
      };
    }
    return buildSessionHookScope({
      pluginRegistry: ctx.pluginRegistry,
      activePluginIds,
      userSettings,
    });
  }

  async function processTurnResults(
    execution: import("@covel/runtime").ExecutedTurn,
    emitter: ReturnType<typeof createTurnEmitter>,
    hookScope: HookScope,
    opts: {
      readonly executionSignal?: AbortSignal;
      readonly proposalGuard?: Parameters<
        typeof commitExecution
      >[0]["proposalGuard"];
      readonly completionKind?: "turn" | "detached";
      readonly extraInTx?: (tx: StoreTransaction) => Promise<void>;
    } = {},
  ): Promise<TurnCommitOutcome> {
    const turnResult = execution.result;
    const outcome = await commitExecution({
      memorySystem: ctx.memorySystem,
      imageFlowRuntimeIds: await ctx.resolveImageFlowRuntimeIds?.(),
      signal: opts.executionSignal,
      completion:
        opts.completionKind === "detached"
          ? { kind: "detached", turnId: turnResult.turnId }
          : {
              kind: "turn",
              turnId: turnResult.turnId,
              durationMs: turnResult.durationMs,
            },
      onFinalized: async (outcome) => {
        // Commit failures must not report success. Surface each one as a
        // `proposal.failed` trace event (manual/background turns have no live
        // action stream; the /debug timeline and subscription channel carry it).
        for (const fp of outcome.failedProposals) {
          await emitter.emit("proposal.failed", {
            proposalId: fp.proposal.id,
            proposalType: fp.proposal.type,
            runtimeId: fp.proposal.source.runtimeId,
            pluginId: fp.proposal.source.pluginId,
            error: fp.error,
          });
        }
      },
      store: ctx.store,
      execution,
      activePluginIds: hookScope.activePluginIds,
      ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
      eventBus: ctx.eventBus,
      emitter,
      ...(opts.extraInTx ? { extraInTx: opts.extraInTx } : {}),
      ...(opts.proposalGuard ? { proposalGuard: opts.proposalGuard } : {}),
      // MediaRef canonicalization / ownership for published export values.
      ...(ctx.deps.mediaStore ? { mediaStore: ctx.deps.mediaStore } : {}),
    });

    const committed = outcome.status === "committed";
    const conflict = outcome.failedProposals.find(
      (item) =>
        item.proposal.type === "dimension.update" &&
        item.error?.startsWith("dimension-version-conflict"),
    );
    const currentVersions = conflict
      ? Object.fromEntries(
          (
            await ctx.store.listPluginData(
              ctx.sessionId,
              conflict.proposal.source.pluginId,
              DIMENSION_DATA_NAMESPACE,
            )
          ).map((row) => [
            row.key,
            dimensionRecordSchema.parse(row.value).version,
          ]),
        )
      : undefined;
    return {
      ...(currentVersions
        ? {
            dimensionConflict: {
              code: "dimension-version-conflict" as const,
              currentVersions,
            },
          }
        : {}),
      committed,
      failedProposalCount: outcome.failedProposals.length,
      snapshotFailed: outcome.snapshotFailed,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /**
   * Run a detached execution: the runtime executes OUTSIDE the session lock and
   * only its commit takes it. Shared by deferred followers and by manual
   * triggers in `execution: background` mode — both are media generations that
   * legitimately run for minutes, and holding the session lock across that
   * makes every player action queue behind them (under PostgreSQL, where the
   * acquire budget is 30s, it makes them fail outright).
   *
   * Executing unlocked is safe here because the session clock is untouched
   * (this path passes no `sessionClock` to `finalizeExecution`, and
   * `completedPlayerTurns` counts only player-origin executions), domain writes
   * are buffered into the commit transaction rather than dribbling out during
   * the run, and no turn messages are appended. Executions of the SAME runtime
   * stay serialised on the injected cross-process session lock, using a key
   * distinct from the session commit lock. This keeps a handler's "already
   * generated?" check and provider call atomic across pods without blocking
   * player turns; the nested commit lock uses the plain session id, so the two
   * acquisitions cannot self-deadlock.
   */
  async function runDetached(
    runtimeId: string,
    turnInput: TurnInput,
    emitter: ReturnType<typeof createTurnEmitter>,
    opts: {
      readonly expectedSessionIncarnation?: string;
      readonly expectedPluginVersion?: string;
      readonly expectedPluginId?: string;
      readonly beforeCommit?: (args: {
        readonly backgroundTurnId: string;
        readonly backgroundExecutionId: string;
      }) => Promise<void>;
      readonly beforeExecute?: () => Promise<void>;
      readonly executionSignal?: AbortSignal;
      readonly rejectSuspension?: boolean;
      readonly proposalGuard?: Parameters<
        typeof commitExecution
      >[0]["proposalGuard"];
      readonly completionKind?: "turn" | "detached";
      readonly completeInTx?: RunDetachedStageArgs["completeInTx"];
    } = {},
  ): Promise<{
    readonly turnResult: import("@covel/shared").TurnResult;
    readonly commit: TurnCommitOutcome;
  }> {
    const userSettings = snapshotUserSettings(turnInput.userSettings);
    const executionInput = { ...turnInput, userSettings };
    const turnControl = executionControl(opts.executionSignal);
    const executionSignal = turnControl?.executionSignal;
    const waitBudget: SettleWaitBudget = {
      startedAt: performance.now(),
      deadline: Infinity,
    };
    const retryAdmission = Symbol(
      "retry settled admission without runtime lock",
    );
    const needsSettle = !opts.expectedSessionIncarnation && ctx.withSettledLock;
    let settleTimedOut = false;
    const jobLockId = backgroundRuntimeLockId(ctx.sessionId, runtimeId);
    for (;;) {
      if (needsSettle) {
        await ctx.withSettledLock!(async () => {
          // The barrier admits pending jobs only after its wait budget expired.
          // Remember that admission across the subsequent runtime-lock acquire.
          settleTimedOut =
            (await listSettlingRuntimeJobs(ctx.store, ctx.sessionId)).length >
            0;
        }, waitBudget);
      }
      try {
        return await ctx.sessionLock.withLock(jobLockId, () =>
          withSnapshot(
            async () => {
              const target = activeRuntimes().find(
                (runtime) => runtime.name === runtimeId,
              );
              if (
                !target ||
                (opts.expectedPluginId &&
                  target.pluginId !== opts.expectedPluginId)
              ) {
                throw new SessionApprovalScopeChangedError();
              }
              const proposalGuard =
                opts.completionKind === "detached"
                  ? createDetachedProposalGuard(target)
                  : opts.proposalGuard;
              executionSignal?.throwIfAborted();
              // Detached work does not hold the main session lock during provider
              // execution. Take it briefly to linearize authorization against a
              // concurrent revoke/disable/delete before spending external work.
              const executionScope = await withBackgroundSessionLock(
                ctx.sessionLock,
                ctx.sessionId,
                async () => {
                  const live = await requireLiveApprovedSession(runtimeId);
                  if (
                    opts.expectedSessionIncarnation &&
                    sessionIncarnationIdentity(live) !==
                      opts.expectedSessionIncarnation
                  ) {
                    throw new SessionApprovalScopeChangedError();
                  }
                  const target = activeRuntimes().find(
                    (runtime) => runtime.name === runtimeId,
                  );
                  if (
                    opts.expectedPluginVersion !== undefined &&
                    target?.version !== opts.expectedPluginVersion
                  ) {
                    throw new SessionApprovalScopeChangedError();
                  }
                  await opts.beforeExecute?.();
                  executionSignal?.throwIfAborted();
                  return hookScopeFor(live.activePlugins, userSettings);
                },
                executionSignal,
              );
              const execution = await executeTurn(
                executionInput,
                activeRuntimes(),
                {
                  ...ctx.deps,
                  hookScope: executionScope,
                  store: ctx.store,
                  eventBus: ctx.eventBus,
                  emitter,
                  ...(ctx.hookPipeline
                    ? { hookPipeline: ctx.hookPipeline }
                    : {}),
                  turnControl,
                },
              );
              const { result } = execution;
              if (
                opts.rejectSuspension === true &&
                [
                  ...result.runtimeResults,
                  ...(result.nestedRuntimeResults ?? []),
                ].some((runtimeResult) => runtimeResult.status === "suspended")
              ) {
                throw new Error(
                  "detached stage runtimes cannot suspend for input",
                );
              }
              const outcome = await withBackgroundSessionLock(
                ctx.sessionLock,
                ctx.sessionId,
                async () => {
                  // Minutes can pass while the generation runs, so the session state
                  // read before it started is no longer trustworthy. Re-read under
                  // the lock and refuse to commit into a session the player has since
                  // paused or ended — the runtime job worker settles the throw
                  // as a stale job.
                  const live = await ctx.store.getSession(ctx.sessionId);
                  if (!live) {
                    throw new SessionNotActiveError("deleted");
                  }
                  if (live.status !== "active") {
                    throw new SessionNotActiveError(live.status);
                  }
                  assertApprovalScope(live, runtimeId);
                  if (
                    opts.expectedSessionIncarnation &&
                    sessionIncarnationIdentity(live) !==
                      opts.expectedSessionIncarnation
                  ) {
                    throw new SessionApprovalScopeChangedError();
                  }
                  if (opts.beforeCommit) {
                    await opts.beforeCommit({
                      backgroundTurnId: result.turnId,
                      backgroundExecutionId:
                        result.executionContext.executionId,
                    });
                  }
                  const completeInTx = opts.completeInTx;
                  return processTurnResults(
                    execution,
                    emitter,
                    hookScopeFor(live.activePlugins, userSettings),
                    {
                      executionSignal,
                      ...(completeInTx
                        ? { extraInTx: (tx) => completeInTx(tx, result) }
                        : {}),
                      ...(proposalGuard ? { proposalGuard } : {}),
                      ...(opts.completionKind !== undefined
                        ? { completionKind: opts.completionKind }
                        : {}),
                    },
                  );
                },
                executionSignal,
              );
              return { turnResult: result, commit: outcome };
            },
            needsSettle && !settleTimedOut
              ? async () => {
                  // The host invokes this under the same session lock as artifact
                  // capture. Release the runtime lock before waiting on raced jobs:
                  // the settling worker may need this same runtime key to finish.
                  if (
                    (await listSettlingRuntimeJobs(ctx.store, ctx.sessionId))
                      .length
                  )
                    throw retryAdmission;
                }
              : undefined,
          ),
        );
      } catch (error) {
        if (error !== retryAdmission) throw error;
      }
    }
  }

  async function runManualTurn(
    args: RunManualTurnArgs,
  ): Promise<ManualTurnSummary> {
    const emitter = createTurnEmitter({
      store: ctx.store,
      eventBus: ctx.eventBus,
      sessionId: ctx.sessionId,
      turnId: args.turnId,
      concealedRuntimeIds: concealedRuntimeIds(activeRuntimes()),
    });
    const turnInput: TurnInput = {
      sessionId: ctx.sessionId,
      turnId: args.turnId,
      playerMessage: "",
      locale: ctx.session.locale,
      // A manual RPC trigger is not a player turn.
      origin: "manual",
      manualTrigger: {
        runtimeId: args.runtimeId,
        ...(args.sourceTurnId ? { sourceTurnId: args.sourceTurnId } : {}),
        ...(args.payload !== undefined && args.payload !== null
          ? { payload: args.payload as Record<string, unknown> }
          : {}),
        ...(args.retrySeedResults && args.retrySeedResults.length > 0
          ? { retrySeedResults: args.retrySeedResults }
          : {}),
      },
      ...(ctx.session.runtimeModelOverrides
        ? { runtimeModelOverrides: ctx.session.runtimeModelOverrides }
        : {}),
      ...(args.userSettings && Object.keys(args.userSettings).length > 0
        ? { userSettings: args.userSettings }
        : {}),
    };

    const userSettings = snapshotUserSettings(turnInput.userSettings);
    const executionInput = { ...turnInput, userSettings };

    // Background mode has already returned 202 to the client and detached from
    // the request, and the only manual runtime that uses it is a media
    // generation (mimo-tts/manual-narrate) — exactly the shape that must not
    // hold the session lock. Sync mode is request-bound, short, and its caller
    // awaits the HTTP response, so it keeps the whole run serialised.
    const turnControl = executionControl(args.executionSignal);
    const executionSignal = turnControl?.executionSignal;
    const { result, commit } = args.detached
      ? await runDetached(args.runtimeId, executionInput, emitter, {
          executionSignal: args.executionSignal,
          ...queuedRunOptions(args),
          ...(args.completeInTx ? { completeInTx: args.completeInTx } : {}),
        }).then((r) => ({
          result: r.turnResult,
          commit: r.commit,
        }))
      : await (
          ctx.withSettledLock ??
          ((fn) => ctx.sessionLock.withLock(ctx.sessionId, fn))
        )(() =>
          withSnapshot(async () => {
            const live = await requireLiveApprovedSession(args.runtimeId);
            const hookScope = hookScopeFor(live.activePlugins, userSettings);
            executionSignal?.throwIfAborted();
            const execution = await executeTurn(
              executionInput,
              activeRuntimes(),
              {
                ...ctx.deps,
                hookScope,
                turnControl,
                store: ctx.store,
                eventBus: ctx.eventBus,
                emitter,
                ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
              },
            );
            const completeInTx = args.completeInTx;
            const outcome = await processTurnResults(
              execution,
              emitter,
              hookScope,
              {
                executionSignal,
                ...(completeInTx
                  ? { extraInTx: (tx) => completeInTx(tx, execution.result) }
                  : {}),
              },
            );
            return { result: execution.result, commit: outcome };
          }),
        );

    return {
      commit,
      turnId: args.turnId,
      runtimeResults: result.runtimeResults.map((rr) => ({
        runtimeId: rr.runtimeId,
        pluginId: rr.pluginId,
        status: rr.status,
        durationMs: rr.durationMs,
        ...(rr.error ? { error: rr.error } : {}),
        output: rr.output,
      })),
      durationMs: result.durationMs,
      ...(result.abortReason ? { abortReason: result.abortReason } : {}),
      deferredFollowers: result.deferredFollowers ?? [],
    };
  }

  async function runDeferredFollowerTurn(
    args: RunDeferredFollowerArgs,
  ): Promise<{
    readonly turnResult: import("@covel/shared").TurnResult;
    readonly commit: TurnCommitOutcome;
  }> {
    const emitter = createTurnEmitter({
      store: ctx.store,
      eventBus: ctx.eventBus,
      sessionId: ctx.sessionId,
      turnId: args.followerTurnId,
      concealedRuntimeIds: concealedRuntimeIds(activeRuntimes()),
    });
    const turnInput: TurnInput = {
      sessionId: ctx.sessionId,
      turnId: args.followerTurnId,
      playerMessage: "",
      locale: ctx.session.locale,
      // A deferred background follower is not a player turn.
      origin: "background",
      manualTrigger: {
        runtimeId: args.runtimeId,
        triggerEvent: args.triggerEvent,
      },
      ...(ctx.session.runtimeModelOverrides
        ? { runtimeModelOverrides: ctx.session.runtimeModelOverrides }
        : {}),
      ...(args.userSettings && Object.keys(args.userSettings).length > 0
        ? { userSettings: args.userSettings }
        : {}),
    };

    return runDetached(args.runtimeId, turnInput, emitter, {
      executionSignal: args.executionSignal,
      ...queuedRunOptions(args),
      ...(args.completeInTx ? { completeInTx: args.completeInTx } : {}),
    });
  }

  async function runDetachedStage(args: RunDetachedStageArgs): Promise<{
    readonly turnResult: import("@covel/shared").TurnResult;
    readonly commit: TurnCommitOutcome;
  }> {
    const emitter = createTurnEmitter({
      store: ctx.store,
      eventBus: ctx.eventBus,
      sessionId: ctx.sessionId,
      turnId: args.backgroundTurnId,
      concealedRuntimeIds: concealedRuntimeIds(activeRuntimes()),
    });
    const turnInput: TurnInput = {
      sessionId: ctx.sessionId,
      turnId: args.backgroundTurnId,
      playerMessage: "",
      locale: ctx.session.locale,
      origin: "background",
      parentTurnId: args.descriptor.sourceTurnId,
      detachedStage: {
        jobId: args.descriptor.jobId,
        runtimeId: args.descriptor.runtimeId,
        sourceTurnId: args.descriptor.sourceTurnId,
        sourceExecutionId: args.descriptor.sourceExecutionId,
        sourceExecutionStartedAt: args.descriptor.sourceExecutionStartedAt,
        ...(args.descriptor.sourceLogicalTurnId
          ? { sourceLogicalTurnId: args.descriptor.sourceLogicalTurnId }
          : {}),
        upstreamResults: args.descriptor.upstreamResults,
        turnDigest: args.descriptor.turnDigest,
      },
      ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
      ...(args.runtimeModelOverrides
        ? { runtimeModelOverrides: args.runtimeModelOverrides }
        : {}),
      ...(args.userSettings ? { userSettings: args.userSettings } : {}),
    };
    return runDetached(args.descriptor.runtimeId, turnInput, emitter, {
      expectedSessionIncarnation: args.expectedSessionIncarnation,
      ...(args.descriptor.pluginVersion
        ? { expectedPluginVersion: args.descriptor.pluginVersion }
        : {}),
      beforeCommit: args.beforeCommit,
      completeInTx: args.completeInTx,
      ...(args.beforeExecute ? { beforeExecute: args.beforeExecute } : {}),
      ...(args.executionSignal
        ? { executionSignal: args.executionSignal }
        : {}),
      expectedPluginId: args.descriptor.pluginId,
      completionKind: "detached",
      rejectSuspension: true,
    });
  }

  return { runManualTurn, runDeferredFollowerTurn, runDetachedStage };
}
