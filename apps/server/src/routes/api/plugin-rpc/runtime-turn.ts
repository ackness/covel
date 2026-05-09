import {
  createTurnEmitter,
  executeTurn,
  type TurnExecutorDeps,
} from "@covel/runtime";
import type { DataStore, SessionRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { RuntimeManifest, TurnInput } from "@covel/shared";

import type { SessionLock } from "../../../lib/session-lock.js";
import { createRuntimeResultProcessor } from "../runtime-result-processor.js";
import type { ManualTurnSummary } from "./runtime-response.js";

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
  }>;
} {
  async function processTurnResults(
    turnResult: Awaited<ReturnType<typeof executeTurn>>,
    emitter: ReturnType<typeof createTurnEmitter>,
  ): Promise<void> {
    const resultProcessor = createRuntimeResultProcessor({
      store: ctx.store,
      sessionId: ctx.sessionId,
      runtimes: ctx.activeRuntimes,
      ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
      eventBus: ctx.eventBus,
      emitter,
    });
    await resultProcessor.processAll(turnResult.runtimeResults);
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

    const result = await ctx.sessionLock.withLock(ctx.sessionId, () =>
      executeTurn(turnInput, ctx.activeRuntimes, {
        ...ctx.deps,
        store: ctx.store,
        eventBus: ctx.eventBus,
        emitter,
        ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
      }),
    );

    await processTurnResults(result, emitter);

    return {
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
  ): Promise<{ readonly turnResult: Awaited<ReturnType<typeof executeTurn>> }> {
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

    const turnResult = await executeTurn(turnInput, ctx.activeRuntimes, {
      ...ctx.deps,
      store: ctx.store,
      eventBus: ctx.eventBus,
      emitter,
      ...(ctx.hookPipeline ? { hookPipeline: ctx.hookPipeline } : {}),
    });
    await processTurnResults(turnResult, emitter);

    return { turnResult };
  }

  return { runManualTurn, runDeferredFollowerTurn };
}
