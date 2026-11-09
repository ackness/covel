import type { Context } from "hono";
import { errorBody } from "../../../api-error.js";
import {
  DIMENSION_DATA_NAMESPACE,
  concealedRuntimeIds,
  dimensionRecordSchema,
} from "@covel/shared";
import { abandonOnThrow, commitExecution } from "../commit-execution.js";
import {
  createTurnEmitter,
  createDetachedProposalGuard,
  executeTurn,
  buildHookSettings,
  refuseReleasedJobs,
  snapshotUserSettings,
  type CommitIsolation,
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
import {
  SessionNotActiveError,
  requireActiveSession,
} from "../execution-context.js";
import { buildSessionHookScope } from "../session/hook-scope.js";
import { RuntimeJobQueueFullError, listSettlingRuntimeJobs } from "./jobs.js";
import {
  heldJobsRelease,
  type SuspensionAbandonDeps,
} from "../suspension-abandon.js";
import {
  NO_FOLLOW_UPS,
  type CommitFollowUpQueue,
  type QueuedCommitFollowUps,
} from "../commit-envelope.js";
import type { SettleWaitBudget } from "./settled-session-lock.js";

export class SessionApprovalScopeChangedError extends Error {
  constructor() {
    super("approval scope changed while the runtime request was waiting");
    this.name = "SessionApprovalScopeChangedError";
  }
}

/** Check the accepted approval scope against the live row under the lock. */
export async function requireLiveScope(
  store: Pick<DataStore, "getSession">,
  sessionId: string,
  pluginId: string,
  approvalScope: string,
): Promise<SessionRecord> {
  const live = await requireActiveSession(store, sessionId);
  if (sessionApprovalScope(live, pluginId) !== approvalScope)
    throw new SessionApprovalScopeChangedError();
  return live;
}

export function runtimeQueueErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof SessionNotActiveError)
    return c.json(errorBody(err.message, { code: "session_not_active" }), 409);
  if (err instanceof SessionApprovalScopeChangedError)
    return c.json(
      errorBody(err.message, { code: "approval_scope_changed" }),
      409,
    );
  if (err instanceof RuntimeJobQueueFullError)
    return c.json(
      errorBody(err.message, { code: "background_queue_full" }),
      429,
    );
  throw err;
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
  /**
   * Queues the jobs an older suspension's turn held back when a suspension
   * this run saves replaces it. Without it such a commit rolls back; runs
   * that cannot suspend (background work) need none.
   */
  readonly heldJobs?: SuspensionAbandonDeps;
}

/**
 * Durable-worker hooks for a queued run: admission and commit barriers, and a
 * write that settles the job in the same transaction as the domain commit.
 */
/**
 * What a run's commit does in its transaction: settle the follow-up work its
 * result derived, then whatever else the caller commits with it (a queued
 * job's own completion), seeing what was queued.
 */
export interface RunCommitSteps {
  /**
   * Required, so that no commit loses follow-up work: a caller queues it or,
   * where its runs derive none, refuses it.
   */
  readonly followUps: CommitFollowUpQueue;
  readonly completeInTx?: (
    tx: StoreTransaction,
    result: import("@covel/shared").TurnResult,
    isolation: CommitIsolation,
    queued: QueuedCommitFollowUps,
  ) => Promise<void>;
}

/** A run's commit outcome and the follow-up work it queued. */
export interface RunCommitOutcome extends TurnCommitOutcome {
  /** What the commit queued, to announce after it; nothing unless it landed. */
  readonly followUps: QueuedCommitFollowUps;
}

export interface QueuedRunControl {
  readonly expectedSessionIncarnation?: string;
  /** The plugin version the job was admitted under; checked again at commit. */
  readonly expectedPluginVersion?: string;
  readonly beforeExecute?: () => Promise<void>;
  /** The runtime returned; the wait for the session commit lock follows. */
  readonly executionFinished?: () => void;
  readonly beforeCommit?: (args: {
    readonly backgroundTurnId: string;
    readonly backgroundExecutionId: string;
  }) => Promise<void>;
}

export interface RunManualTurnArgs extends QueuedRunControl, RunCommitSteps {
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
  /**
   * The player's plugin settings. Every run snapshots them once, as it builds
   * its turn input, so the execution and its hooks read one frozen copy.
   */
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
}

export interface RunDeferredFollowerArgs
  extends QueuedRunControl, RunCommitSteps {
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
}

export interface RunDetachedStageArgs extends RunCommitSteps {
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
  readonly completeInTx: NonNullable<RunCommitSteps["completeInTx"]>;
  readonly beforeExecute?: () => Promise<void>;
  readonly executionFinished?: () => void;
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

/** Only the commit steps of a run's arguments. */
function commitStepsOf(steps: RunCommitSteps): RunCommitSteps {
  return {
    followUps: steps.followUps,
    ...(steps.completeInTx ? { completeInTx: steps.completeInTx } : {}),
  };
}

function queuedRunOptions(control: QueuedRunControl): QueuedRunControl {
  return {
    ...(control.expectedSessionIncarnation
      ? { expectedSessionIncarnation: control.expectedSessionIncarnation }
      : {}),
    ...(control.expectedPluginVersion !== undefined
      ? { expectedPluginVersion: control.expectedPluginVersion }
      : {}),
    ...(control.beforeExecute ? { beforeExecute: control.beforeExecute } : {}),
    ...(control.executionFinished
      ? { executionFinished: control.executionFinished }
      : {}),
    ...(control.beforeCommit ? { beforeCommit: control.beforeCommit } : {}),
  };
}

export function createPluginRpcRuntimeTurnRunner(
  ctx: PluginRpcRuntimeTurnContext,
): {
  runManualTurn(
    args: RunManualTurnArgs,
  ): Promise<ManualTurnSummary & { readonly commit: RunCommitOutcome }>;
  runDeferredFollowerTurn(args: RunDeferredFollowerArgs): Promise<{
    readonly turnResult: import("@covel/shared").TurnResult;
    readonly commit: RunCommitOutcome;
  }>;
  runDetachedStage(args: RunDetachedStageArgs): Promise<{
    readonly turnResult: import("@covel/shared").TurnResult;
    readonly commit: RunCommitOutcome;
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

  /** The live session, still active and under the accepted approval scope. */
  async function requireLiveApprovedSession(
    runtimeId: string,
  ): Promise<SessionRecord> {
    const live = await requireActiveSession(ctx.store, ctx.sessionId);
    assertApprovalScope(live, runtimeId);
    return live;
  }

  function hookScopeFor(
    live: SessionRecord,
    userSettings: TurnInput["userSettings"],
  ): HookScope {
    // A runner built without a registry (tests) scopes hooks to its runtimes.
    if (!ctx.pluginRegistry) {
      return {
        activePluginIds: new Set(
          activeRuntimes().map((runtime) => runtime.pluginId),
        ),
        settings: buildHookSettings(activeRuntimes(), userSettings),
        locale: live.locale,
      };
    }
    return buildSessionHookScope({
      pluginRegistry: ctx.pluginRegistry,
      session: live,
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
      readonly commitSteps: RunCommitSteps;
    },
  ): Promise<RunCommitOutcome> {
    const turnResult = execution.result;
    const release = ctx.heldJobs
      ? heldJobsRelease(ctx.heldJobs, ctx.sessionId)
      : undefined;
    const { followUps, completeInTx } = opts.commitSteps;
    // What the landed transaction queued; a retried one replaces it.
    let queued = NO_FOLLOW_UPS;
    const outcome = await commitExecution({
      // Runners built without `heldJobs` are the background job worker, whose
      // runs reject suspension before commit, and the dimension-settlement
      // retry. A commit of theirs that would release held-back jobs rolls
      // back instead of losing them.
      enqueueReleasedJobsInTx: release?.enqueueInTx ?? refuseReleasedJobs,
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
      extraInTx: async (tx, isolation) => {
        queued = await followUps(tx, turnResult, isolation);
        await completeInTx?.(tx, turnResult, isolation, queued);
      },
      ...(opts.proposalGuard ? { proposalGuard: opts.proposalGuard } : {}),
      // MediaRef canonicalization / ownership for published export values.
      ...(ctx.deps.mediaStore ? { mediaStore: ctx.deps.mediaStore } : {}),
    });

    const committed = outcome.status === "committed";
    if (committed) await release?.publish();
    const conflict = outcome.failedProposals.find(
      (item) =>
        item.proposal.type === "dimension.update" &&
        item.code === "dimension-version-conflict",
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
      followUps: committed ? queued : NO_FOLLOW_UPS,
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
      readonly executionFinished?: () => void;
      readonly executionSignal?: AbortSignal;
      /** Background work: a suspended runtime fails the run, nothing commits. */
      readonly rejectSuspension?: boolean;
      readonly proposalGuard?: Parameters<
        typeof commitExecution
      >[0]["proposalGuard"];
      readonly completionKind?: "turn" | "detached";
      readonly commitSteps: RunCommitSteps;
    },
  ): Promise<{
    readonly turnResult: import("@covel/shared").TurnResult;
    readonly commit: RunCommitOutcome;
  }> {
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
    const assertPluginVersion = (): void => {
      if (opts.expectedPluginVersion === undefined) return;
      const target = activeRuntimes().find(
        (runtime) => runtime.name === runtimeId,
      );
      if (target?.version !== opts.expectedPluginVersion) {
        throw new SessionApprovalScopeChangedError();
      }
    };
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
                  assertPluginVersion();
                  await opts.beforeExecute?.();
                  executionSignal?.throwIfAborted();
                  return hookScopeFor(live, turnInput.userSettings);
                },
                executionSignal,
              );
              const execution = await executeTurn(turnInput, activeRuntimes(), {
                ...ctx.deps,
                hookScope: executionScope,
                store: ctx.store,
                eventBus: ctx.eventBus,
                emitter,
                ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
                turnControl,
              });
              return abandonOnThrow(ctx.store, execution, async () => {
                // A player turn may hold the session lock for minutes; the
                // queued job's execution deadline does not cover that wait.
                opts.executionFinished?.();
                const { result } = execution;
                if (
                  opts.rejectSuspension === true &&
                  [
                    ...result.runtimeResults,
                    ...(result.nestedRuntimeResults ?? []),
                  ].some(
                    (runtimeResult) => runtimeResult.status === "suspended",
                  )
                ) {
                  throw new Error(
                    "background runtimes cannot suspend for input",
                  );
                }
                const outcome = await withBackgroundSessionLock(
                  ctx.sessionLock,
                  ctx.sessionId,
                  async () => {
                    // Minutes can pass while the generation runs, so the
                    // session state read before it started is no longer
                    // trustworthy. Re-read under the lock and refuse to
                    // commit into a session the player has since paused or
                    // ended — the runtime job worker settles the throw as a
                    // stale job, and `abandonOnThrow` its record.
                    const live = await requireLiveApprovedSession(runtimeId);
                    // A development reload can replace the plugin while the
                    // generation runs; its results belong to the old version.
                    assertPluginVersion();
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
                    return processTurnResults(
                      execution,
                      emitter,
                      hookScopeFor(live, turnInput.userSettings),
                      {
                        executionSignal,
                        commitSteps: opts.commitSteps,
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
              });
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
  ): Promise<ManualTurnSummary & { readonly commit: RunCommitOutcome }> {
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
        ? { userSettings: snapshotUserSettings(args.userSettings) }
        : {}),
    };

    // Background mode has already returned 202 to the client and detached from
    // the request, and the only manual runtime that uses it is a media
    // generation (mimo-tts/manual-narrate) — exactly the shape that must not
    // hold the session lock. Sync mode is request-bound, short, and its caller
    // awaits the HTTP response, so it keeps the whole run serialised.
    const turnControl = executionControl(args.executionSignal);
    const executionSignal = turnControl?.executionSignal;
    const { result, commit } = args.detached
      ? await runDetached(args.runtimeId, turnInput, emitter, {
          executionSignal: args.executionSignal,
          ...queuedRunOptions(args),
          commitSteps: commitStepsOf(args),
          rejectSuspension: true,
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
            const hookScope = hookScopeFor(live, turnInput.userSettings);
            executionSignal?.throwIfAborted();
            const execution = await executeTurn(turnInput, activeRuntimes(), {
              ...ctx.deps,
              hookScope,
              turnControl,
              store: ctx.store,
              eventBus: ctx.eventBus,
              emitter,
              ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
            });
            const outcome = await abandonOnThrow(ctx.store, execution, () =>
              processTurnResults(execution, emitter, hookScope, {
                executionSignal,
                commitSteps: commitStepsOf(args),
              }),
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
    readonly commit: RunCommitOutcome;
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
        ? { userSettings: snapshotUserSettings(args.userSettings) }
        : {}),
    };

    return runDetached(args.runtimeId, turnInput, emitter, {
      executionSignal: args.executionSignal,
      ...queuedRunOptions(args),
      commitSteps: commitStepsOf(args),
      rejectSuspension: true,
    });
  }

  async function runDetachedStage(args: RunDetachedStageArgs): Promise<{
    readonly turnResult: import("@covel/shared").TurnResult;
    readonly commit: RunCommitOutcome;
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
      locale: args.descriptor.presentation?.locale ?? ctx.session.locale,
      origin: "background",
      parentTurnId: args.descriptor.sourceTurnId,
      actions: args.descriptor.turnDigest.actions,
      logicalTurn: args.descriptor.sourceLogicalTurn,
      detachedStage: {
        ...(args.descriptor.presentation
          ? { presentation: args.descriptor.presentation }
          : {}),
        jobId: args.descriptor.jobId,
        runtimeId: args.descriptor.runtimeId,
        sourceTurnId: args.descriptor.sourceTurnId,
        sourceExecutionId: args.descriptor.sourceExecutionId,
        sourceExecutionStartedAt: args.descriptor.sourceExecutionStartedAt,
        ...(typeof args.descriptor.sourceLogicalTurn === "number"
          ? { sourceLogicalTurn: args.descriptor.sourceLogicalTurn }
          : {}),
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
      ...(args.userSettings
        ? { userSettings: snapshotUserSettings(args.userSettings) }
        : {}),
    };
    return runDetached(args.descriptor.runtimeId, turnInput, emitter, {
      expectedSessionIncarnation: args.expectedSessionIncarnation,
      ...(args.descriptor.pluginVersion
        ? { expectedPluginVersion: args.descriptor.pluginVersion }
        : {}),
      beforeCommit: args.beforeCommit,
      commitSteps: commitStepsOf(args),
      ...(args.beforeExecute ? { beforeExecute: args.beforeExecute } : {}),
      ...(args.executionFinished
        ? { executionFinished: args.executionFinished }
        : {}),
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
