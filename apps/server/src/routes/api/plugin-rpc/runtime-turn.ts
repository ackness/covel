import {
  createTurnEmitter,
  executeTurn,
  finalizeExecution,
  saveAutoSnapshot,
  type TurnExecutorDeps,
} from "@covel/runtime";
import type { DataStore, SessionRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { RuntimeManifest, TurnInput } from "@covel/shared";

import type { SessionLock } from "../../../lib/session-lock.js";
import type {
  ManualTurnSummary,
  TurnCommitOutcome,
} from "./runtime-response.js";

export interface PluginRpcRuntimeTurnContext {
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly sessionLock: SessionLock;
  readonly sessionId: string;
  readonly session: Pick<SessionRecord, "locale" | "runtimeModelOverrides">;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly deps: Omit<TurnExecutorDeps, "store" | "eventBus" | "emitter">;
  readonly hookPipeline?: TurnExecutorDeps["hookPipeline"];
}

export interface RunManualTurnArgs {
  readonly turnId: string;
  readonly runtimeId: string;
  readonly payload?: unknown;
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
}

export interface RunDeferredFollowerArgs {
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

export function createPluginRpcRuntimeTurnRunner(
  ctx: PluginRpcRuntimeTurnContext,
): {
  runManualTurn(args: RunManualTurnArgs): Promise<ManualTurnSummary>;
  runDeferredFollowerTurn(args: RunDeferredFollowerArgs): Promise<{
    readonly turnResult: Awaited<ReturnType<typeof executeTurn>>;
    readonly commit: TurnCommitOutcome;
  }>;
} {
  async function processTurnResults(
    turnResult: Awaited<ReturnType<typeof executeTurn>>,
    emitter: ReturnType<typeof createTurnEmitter>,
  ): Promise<TurnCommitOutcome> {
    // Commit the whole execution (top-level + nested recursiveCall results) in
    // ONE transaction via the shared finalize primitive. Any proposal failure
    // rolls the turn back (committed siblings included) and settles the
    // turn_results row to `failed`; a clean run settles it `committed`, both
    // inside that transaction.
    const outcome = await finalizeExecution({
      store: ctx.store,
      sessionId: ctx.sessionId,
      ...(turnResult.executionContext
        ? { executionContext: turnResult.executionContext }
        : {}),
      runtimes: ctx.activeRuntimes,
      results: [
        ...turnResult.runtimeResults,
        ...(turnResult.nestedRuntimeResults ?? []),
      ],
      turnIds: [turnResult.turnId],
      ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
      eventBus: ctx.eventBus,
      emitter,
    });

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

    const committed = outcome.status === "committed";
    let snapshotFailed = false;
    if (committed) {
      try {
        await saveAutoSnapshot({
          store: ctx.store,
          sessionId: ctx.sessionId,
          turnId: turnResult.turnId,
          createdAt: turnResult.timestamp,
          eventBus: ctx.eventBus,
        });
      } catch (err) {
        snapshotFailed = true;
        console.warn(
          `[plugin-rpc] auto snapshot failed for session ${ctx.sessionId} turn ${turnResult.turnId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      console.error(
        `[plugin-rpc] proposal commit failed for session ${ctx.sessionId} turn ${turnResult.turnId} — ` +
          "withholding auto-snapshot and turn completion",
      );
    }

    // Commit barrier: fire the authoritative turn.completed event and memory
    // ingestion only when every proposal committed. A failed auto-snapshot does
    // NOT withhold completion — the proposals already committed (commit_status
    // was settled inside finalize), so business state is consistent and only
    // the best-effort checkpoint is missing; counting it as a failure made the
    // sync RPC return 500 and the client retry, replaying committed proposals.
    // So `committed` tracks proposal commit alone, matching commit_status;
    // `snapshotFailed` stays on the outcome for observability.
    if (committed) {
      turnResult.completeTurn?.();
    }
    return {
      committed,
      failedProposalCount: outcome.failedProposals.length,
      snapshotFailed,
    };
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
      locale: ctx.session.locale ?? "zh-CN",
      // A manual RPC trigger is not a player turn.
      origin: "manual",
      manualTrigger: {
        runtimeId: args.runtimeId,
        ...(args.payload !== undefined && args.payload !== null
          ? { payload: args.payload as Record<string, unknown> }
          : {}),
      },
      ...(ctx.session.runtimeModelOverrides
        ? { runtimeModelOverrides: ctx.session.runtimeModelOverrides }
        : {}),
      ...(args.userSettings && Object.keys(args.userSettings).length > 0
        ? { userSettings: args.userSettings }
        : {}),
    };

    const { result, commit } = await ctx.sessionLock.withLock(
      ctx.sessionId,
      async () => {
        const turnResult = await executeTurn(turnInput, ctx.activeRuntimes, {
          ...ctx.deps,
          store: ctx.store,
          eventBus: ctx.eventBus,
          emitter,
          ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
        });
        const outcome = await processTurnResults(turnResult, emitter);
        return { result: turnResult, commit: outcome };
      },
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
      locale: ctx.session.locale ?? "zh-CN",
      // A deferred background follower is not a player turn.
      origin: "follower",
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

    // Take the per-session lock like runManualTurn / actions / resume. Deferred
    // followers fire via setImmediate after the originating request's lock has
    // released, so without this they can interleave turnNumber computation,
    // state writes, and auto-snapshots with a concurrent player turn on the same
    // session (audit 2026-04-20 finding 1).
    const { turnResult, commit } = await ctx.sessionLock.withLock(
      ctx.sessionId,
      async () => {
        const result = await executeTurn(turnInput, ctx.activeRuntimes, {
          ...ctx.deps,
          store: ctx.store,
          eventBus: ctx.eventBus,
          emitter,
          ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
        });
        const outcome = await processTurnResults(result, emitter);
        return { turnResult: result, commit: outcome };
      },
    );

    return { turnResult, commit };
  }

  return { runManualTurn, runDeferredFollowerTurn };
}
