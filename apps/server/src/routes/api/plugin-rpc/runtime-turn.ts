import {
  createTurnEmitter,
  collectExecutionJournal,
  collectExecutionSuspensions,
  createDetachedProposalGuard,
  executeTurn,
  commitExecution,
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

import type { SessionLock } from "../../../lib/session-lock.js";
import type {
  ManualTurnSummary,
  TurnCommitOutcome,
} from "./runtime-response.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../session/session-guard.js";
import { buildSessionHookScope } from "../session/hook-scope.js";

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
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly sessionLock: SessionLock;
  readonly sessionId: string;
  readonly session: Pick<SessionRecord, "locale" | "runtimeModelOverrides">;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly pluginRegistry?: PluginRegistry;
  /** Capability incarnation captured for every runtime plugin in this graph. */
  readonly approvalScopes: ReadonlyMap<string, string>;
  readonly deps: Omit<TurnExecutorDeps, "store" | "eventBus" | "emitter">;
  readonly hookPipeline?: TurnExecutorDeps["hookPipeline"];
}

export interface RunManualTurnArgs {
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

export interface RunDeferredFollowerArgs {
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
    result: Awaited<ReturnType<typeof executeTurn>>,
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

export function createPluginRpcRuntimeTurnRunner(
  ctx: PluginRpcRuntimeTurnContext,
): {
  runManualTurn(args: RunManualTurnArgs): Promise<ManualTurnSummary>;
  runDeferredFollowerTurn(args: RunDeferredFollowerArgs): Promise<{
    readonly turnResult: Awaited<ReturnType<typeof executeTurn>>;
    readonly commit: TurnCommitOutcome;
  }>;
  runDetachedStage(args: RunDetachedStageArgs): Promise<{
    readonly turnResult: Awaited<ReturnType<typeof executeTurn>>;
    readonly commit: TurnCommitOutcome;
  }>;
} {
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
    const pluginId = ctx.activeRuntimes.find(
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
          ctx.activeRuntimes.map((runtime) => runtime.pluginId),
        ),
        settings: buildHookSettings(ctx.activeRuntimes, userSettings),
      };
    }
    return buildSessionHookScope({
      pluginRegistry: ctx.pluginRegistry,
      activePluginIds,
      userSettings,
    });
  }

  async function processTurnResults(
    turnResult: Awaited<ReturnType<typeof executeTurn>>,
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
    // Commit the whole execution (top-level + nested recursiveCall results) in
    // ONE transaction via the shared finalize primitive. Any proposal failure
    // rolls the turn back (committed siblings included) and settles the
    // turn_results row to `failed`; a clean run settles it `committed`, both
    // inside that transaction.
    const outcome = await commitExecution({
      signal: opts.executionSignal,
      completion:
        opts.completionKind === "detached"
          ? { kind: "detached", turnId: turnResult.turnId }
          : {
              kind: "turn",
              turnId: turnResult.turnId,
              durationMs: turnResult.durationMs,
            },
      memorySystem: ctx.deps.memorySystem,
      capabilityPluginIds: ctx.deps.capabilityPluginIds,
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
      sessionId: ctx.sessionId,
      executionContext: turnResult.executionContext,
      runtimes: ctx.activeRuntimes,
      activePluginIds: hookScope.activePluginIds,
      hookSettings: hookScope.settings,
      results: [
        ...turnResult.runtimeResults,
        ...(turnResult.nestedRuntimeResults ?? []),
      ],
      journalMessages: collectExecutionJournal(turnResult),
      suspensions: collectExecutionSuspensions(turnResult),
      turnIds: [turnResult.turnId],
      ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
      eventBus: ctx.eventBus,
      emitter,
      ...(opts.extraInTx ? { extraInTx: opts.extraInTx } : {}),
      ...(opts.proposalGuard ? { proposalGuard: opts.proposalGuard } : {}),
      // Manual / late-setup runs settle their setup attempts too (a manual
      // retrigger of a pending setup runtime burns an attempt).
      ...(turnResult.setupRan ? { setupRan: turnResult.setupRan } : {}),
      // Publishes recordAs exports inside the commit transaction — a manual /
      // background execution can publish just like a player turn.
      loadOutputSchema: async (runtimeId) => {
        const rt = ctx.activeRuntimes.find((r) => r.name === runtimeId);
        return rt
          ? (await ctx.deps.loadRuntime(rt, ctx.session.locale))?.outputSchema
          : undefined;
      },
      // MediaRef canonicalization / ownership for published export values.
      ...(ctx.deps.mediaStore ? { mediaStore: ctx.deps.mediaStore } : {}),
    });

    const committed = outcome.status === "committed";
    return {
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
    readonly turnResult: Awaited<ReturnType<typeof executeTurn>>;
    readonly commit: TurnCommitOutcome;
  }> {
    const userSettings = snapshotUserSettings(turnInput.userSettings);
    const executionInput = { ...turnInput, userSettings };
    const turnControl = executionControl(opts.executionSignal);
    const executionSignal = turnControl?.executionSignal;
    const jobLockId = backgroundRuntimeLockId(ctx.sessionId, runtimeId);
    return ctx.sessionLock.withLock(jobLockId, async () => {
      executionSignal?.throwIfAborted();
      // Detached work does not hold the main session lock during provider
      // execution. Take it briefly to linearize authorization against a
      // concurrent revoke/disable/delete before spending external work.
      const executionScope = await ctx.sessionLock.withLock(ctx.sessionId, () =>
        requireLiveApprovedSession(runtimeId).then(async (live) => {
          if (
            opts.expectedSessionIncarnation &&
            sessionIncarnationIdentity(live) !== opts.expectedSessionIncarnation
          ) {
            throw new SessionApprovalScopeChangedError();
          }
          const target = ctx.activeRuntimes.find(
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
        }),
      );
      const result = await executeTurn(executionInput, ctx.activeRuntimes, {
        ...ctx.deps,
        hookScope: executionScope,
        store: ctx.store,
        eventBus: ctx.eventBus,
        emitter,
        ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
        turnControl,
      });
      if (
        opts.rejectSuspension === true &&
        [...result.runtimeResults, ...(result.nestedRuntimeResults ?? [])].some(
          (runtimeResult) => runtimeResult.status === "suspended",
        )
      ) {
        throw new Error("detached stage runtimes cannot suspend for input");
      }
      const outcome = await ctx.sessionLock.withLock(
        ctx.sessionId,
        async () => {
          // Minutes can pass while the generation runs, so the session state
          // read before it started is no longer trustworthy. Re-read under
          // the lock and refuse to commit into a session the player has since
          // paused or ended — the throw is caught by the background job
          // runner, which settles the job row as failed.
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
            sessionIncarnationIdentity(live) !== opts.expectedSessionIncarnation
          ) {
            throw new SessionApprovalScopeChangedError();
          }
          if (opts.beforeCommit) {
            await opts.beforeCommit({
              backgroundTurnId: result.turnId,
              backgroundExecutionId: result.executionContext.executionId,
            });
          }
          const completeInTx = opts.completeInTx;
          return processTurnResults(
            result,
            emitter,
            hookScopeFor(live.activePlugins, userSettings),
            {
              executionSignal,
              ...(completeInTx
                ? { extraInTx: (tx) => completeInTx(tx, result) }
                : {}),
              ...(opts.proposalGuard
                ? { proposalGuard: opts.proposalGuard }
                : {}),
              ...(opts.completionKind !== undefined
                ? { completionKind: opts.completionKind }
                : {}),
            },
          );
        },
      );
      return { turnResult: result, commit: outcome };
    });
  }

  async function runManualTurn(
    args: RunManualTurnArgs,
  ): Promise<ManualTurnSummary> {
    const emitter = createTurnEmitter({
      store: ctx.store,
      eventBus: ctx.eventBus,
      sessionId: ctx.sessionId,
      turnId: args.turnId,
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
        }).then((r) => ({
          result: r.turnResult,
          commit: r.commit,
        }))
      : await ctx.sessionLock.withLock(ctx.sessionId, async () => {
          const live = await requireLiveApprovedSession(args.runtimeId);
          const hookScope = hookScopeFor(live.activePlugins, userSettings);
          executionSignal?.throwIfAborted();
          const turnResult = await executeTurn(
            executionInput,
            ctx.activeRuntimes,
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
          const outcome = await processTurnResults(
            turnResult,
            emitter,
            hookScope,
            { executionSignal },
          );
          return { result: turnResult, commit: outcome };
        });

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
    readonly turnResult: Awaited<ReturnType<typeof executeTurn>>;
    readonly commit: TurnCommitOutcome;
  }> {
    const emitter = createTurnEmitter({
      store: ctx.store,
      eventBus: ctx.eventBus,
      sessionId: ctx.sessionId,
      turnId: args.followerTurnId,
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
    });
  }

  async function runDetachedStage(args: RunDetachedStageArgs): Promise<{
    readonly turnResult: Awaited<ReturnType<typeof executeTurn>>;
    readonly commit: TurnCommitOutcome;
  }> {
    const target = ctx.activeRuntimes.find(
      (runtime) => runtime.name === args.descriptor.runtimeId,
    );
    if (!target || target.pluginId !== args.descriptor.pluginId) {
      throw new SessionApprovalScopeChangedError();
    }
    const emitter = createTurnEmitter({
      store: ctx.store,
      eventBus: ctx.eventBus,
      sessionId: ctx.sessionId,
      turnId: args.backgroundTurnId,
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
      proposalGuard: createDetachedProposalGuard(target),
      completionKind: "detached",
      rejectSuspension: true,
    });
  }

  return { runManualTurn, runDeferredFollowerTurn, runDetachedStage };
}
