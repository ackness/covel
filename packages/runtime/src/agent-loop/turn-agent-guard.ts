import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { HookPipeline } from "../hooks/pipeline.js";
import {
  createFunctionStoreView,
  createPluginDataWriter,
  createPluginLogger,
} from "../function-runtime/plugin-handler-helpers.js";
import { createRuntimeMediaContext } from "../function-runtime/runtime-media-context.js";
import { withUtilsTrace } from "../function-runtime/utils-trace.js";
import { runPostRuntimeHook } from "../hooks/wire-helpers.js";
import { resolveUserSettings } from "../turn-executor/turn-executor-helpers.js";
import {
  createAssetProgressEmitter,
  emitSubEvent,
  isTrustedPluginSource,
} from "../turn-executor/turn-runtime-helpers.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { NARRATOR_PRIORITY } from "../schedule/scheduler.js";

export interface ExecuteAgentGuardOptions {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly deps: TurnExecutorDeps;
  readonly hookPipeline: HookPipeline | undefined;
  readonly triggerEvent:
    | {
        readonly topic: string;
        readonly data: Readonly<Record<string, unknown>>;
      }
    | undefined;
  readonly createRecursiveCall: () => (
    delta: Partial<TurnInput>,
    opts?: { readonly reason?: string },
  ) => Promise<TurnResult>;
  readonly recursionDepth: number;
  readonly startTime: number;
  readonly runId: string;
  /**
   * Total-duration hard cap for the guard call (`manifest.timeoutMs` ??
   * executor default) — same contract as the function-runtime handler
   * deadline in `turn-function-runtime.ts`.
   */
  readonly timeoutMs: number;
}

export async function executeAgentGuard({
  manifest,
  input,
  loaded,
  completedResults,
  deps,
  hookPipeline,
  triggerEvent,
  createRecursiveCall,
  recursionDepth,
  startTime,
  runId,
  timeoutMs,
}: ExecuteAgentGuardOptions): Promise<RuntimeResult | undefined> {
  // ── Guard: pre-execution gate for agent runtimes ────────────
  if (loaded.guard) {
    const guardConfig = deps.getConfig(manifest.pluginId, manifest.name);
    const guardManualPayload =
      input.manualTrigger?.runtimeId === manifest.name
        ? input.manualTrigger.payload
        : undefined;
    const guardUserSettings = resolveUserSettings(manifest, input.userSettings);
    const guardHelperCtx = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
    };
    const guardAssetProgress = createAssetProgressEmitter(deps.emitter, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
    });
    // Trace plugin-owned provider HTTP calls from the guard handler too.
    const guardTracedUtils =
      deps.utils && deps.emitter
        ? withUtilsTrace(deps.utils, deps.emitter, guardHelperCtx)
        : deps.utils;
    const guardStore = deps.store
      ? isTrustedPluginSource(deps, manifest)
        ? deps.store
        : createFunctionStoreView(deps.store, guardHelperCtx)
      : undefined;
    const guardPluginDataHandle = deps.store
      ? createPluginDataWriter(deps.store, guardHelperCtx)
      : undefined;
    const guardLoggerHandle = deps.store
      ? createPluginLogger(deps.store, guardHelperCtx)
      : undefined;
    // Deadline race — mirrors the function-runtime handler pattern in
    // `turn-function-runtime.ts`: without it a hung guard blocks the whole
    // turn (and the session lock) forever. Promise.race keeps the guard
    // promise subscribed, so a post-timeout rejection is still observed. The
    // player abort signal lets a cooperative guard cancel in-flight work.
    const guardPromise = loaded.guard({
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      playerMessage: input.playerMessage,
      locale: input.locale,
      store: guardStore,
      completedResults,
      config: guardConfig,
      recursiveCall: createRecursiveCall(),
      recursionDepth,
      ...(deps.gateway ? { gateway: deps.gateway } : {}),
      ...(guardTracedUtils ? { utils: guardTracedUtils } : {}),
      ...(deps.mediaStore
        ? {
            media: createRuntimeMediaContext(deps.mediaStore, deps.utils, {
              sessionId: input.sessionId,
              pluginId: manifest.pluginId,
            }),
          }
        : {}),
      ...(guardAssetProgress ? { assetProgress: guardAssetProgress } : {}),
      ...(guardManualPayload ? { manualPayload: guardManualPayload } : {}),
      ...(triggerEvent ? { triggerEvent } : {}),
      ...(guardUserSettings ? { userSettings: guardUserSettings } : {}),
      ...(guardPluginDataHandle ? { pluginData: guardPluginDataHandle } : {}),
      ...(guardLoggerHandle ? { logger: guardLoggerHandle } : {}),
      ...(deps.turnControl?.signal ? { signal: deps.turnControl.signal } : {}),
    });
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let guardOutput: Awaited<typeof guardPromise>;
    try {
      guardOutput = await Promise.race([
        guardPromise,
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            reject(
              new Error(
                `agent guard "${manifest.name}" timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(deadlineTimer);
    }

    if (guardOutput.skip === true) {
      // Record `skipped` in the internal RuntimeResult so downstream
      // consumers (Pre-Game completion tracker, session-kernel's
      // `result.status !== 'success'` gate, SSE payload) all see the same
      // story. Earlier code set `status: 'success'` here and only reported
      // 'skipped' in the outgoing SSE, which made the Pre-Game tracker's
      // `guardSkipped = result.status === 'skipped'` check dead code.
      const result: RuntimeResult = {
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: input.turnId,
        status: "skipped",
        output: guardOutput,
        toolCalls: [],
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };

      if (
        deps.store &&
        typeof guardOutput.narrativeOutput === "string" &&
        guardOutput.narrativeOutput
      ) {
        await deps.store.appendTurnMessage({
          id: crypto.randomUUID(),
          sessionId: input.sessionId,
          turnId: input.turnId,
          sourceType: "runtime",
          sourcePluginId: manifest.pluginId,
          sourceRuntimeId: manifest.name,
          role: "assistant",
          name: manifest.name,
          content: guardOutput.narrativeOutput as string,
          order: manifest.priority ?? NARRATOR_PRIORITY,
          createdAt: new Date().toISOString(),
        });
      }

      // Guard skipped: emit completed (without ever emitting started) so frontend
      // shows "skipped" instead of an infinite spinner.
      try {
        await deps.onRuntimeComplete?.({
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          status: "skipped",
          durationMs: result.durationMs,
        });
      } catch {
        /* callback error must not kill runtime */
      }

      emitSubEvent(
        deps.eventBus,
        "runtime",
        "runtime.completed",
        input.sessionId,
        {
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          status: "skipped",
          durationMs: result.durationMs,
        },
      );

      // PostRuntime hook — guard-skipped path (S4-T3)
      return runPostRuntimeHook(
        {
          pipeline: hookPipeline,
          sessionId: input.sessionId,
          turnId: input.turnId,
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
          eventBus: deps.eventBus,
          emitter: deps.emitter,
        },
        result,
      );
    }
  }
  return undefined;
}
