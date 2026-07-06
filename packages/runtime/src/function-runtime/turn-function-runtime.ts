import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { SuspensionRecord } from "@covel/store";
import {
  createPluginDataWriter,
  createPluginLogger,
  createFunctionStoreView,
} from "./plugin-handler-helpers.js";
import { createRuntimeMediaContext } from "./runtime-media-context.js";
import { createRuntimeImagesContext } from "./runtime-images-context.js";
import { createRuntimeSpeechContext } from "./runtime-speech-context.js";
import { runPostRuntimeHook } from "../hooks/wire-helpers.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import {
  makeFailedResult,
  resolveUserSettings,
} from "../turn-executor/turn-executor-helpers.js";
import {
  createAssetProgressEmitter,
  emitSubEvent,
  isTrustedPluginSource,
} from "../turn-executor/turn-runtime-helpers.js";
import { withGatewayTrace } from "./gateway-trace.js";
import { withUtilsTrace } from "./utils-trace.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { NARRATOR_PRIORITY } from "../schedule/scheduler.js";

export interface ExecuteFunctionRuntimeOptions {
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
   * Total-duration hard cap for the handler (`manifest.timeoutMs` ??
   * executor default) — the same contract the agent path enforces. Function
   * runtimes have no retry loop, so this is a plain deadline.
   */
  readonly timeoutMs: number;
}

export async function executeFunctionRuntime({
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
}: ExecuteFunctionRuntimeOptions): Promise<RuntimeResult> {
  // Emit start for function runtimes (no guard to check)
  try {
    await deps.onRuntimeStart?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      priority: manifest.priority,
    });
  } catch {
    /* callback error must not kill runtime */
  }
  emitSubEvent(deps.eventBus, "runtime", "runtime.started", input.sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    priority: manifest.priority,
  });

  const helperCtx = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  };

  if (!loaded.handler) {
    // A missing handler returns (never throws), so it would bypass the dispatch
    // catch and leave the runtime.started above with no terminal event. Emit a
    // terminal runtime.failed + run the PostRuntime hook to close that gap.
    const failed = makeFailedResult(
      manifest,
      input,
      runId,
      startTime,
      "Function runtime missing handler",
    );
    try {
      await deps.onRuntimeComplete?.({
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        status: failed.status,
        durationMs: failed.durationMs,
        error: "Function runtime missing handler",
      });
    } catch {
      /* callback error must not kill runtime */
    }
    emitSubEvent(deps.eventBus, "runtime", "runtime.failed", input.sessionId, {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: failed.status,
      durationMs: failed.durationMs,
      error: "Function runtime missing handler",
    });
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
      failed,
    );
  }
  const config = deps.getConfig(manifest.pluginId, manifest.name);
  const manualPayloadForRuntime =
    input.manualTrigger?.runtimeId === manifest.name
      ? input.manualTrigger.payload
      : undefined;
  const userSettingsForRuntime = resolveUserSettings(
    manifest,
    input.userSettings,
  );
  const assetProgress = createAssetProgressEmitter(deps.emitter, helperCtx);
  const pluginDataHandle = deps.store
    ? createPluginDataWriter(deps.store, helperCtx)
    : undefined;
  const loggerHandle = deps.store
    ? createPluginLogger(deps.store, helperCtx)
    : undefined;
  const mediaHandle = deps.mediaStore
    ? createRuntimeMediaContext(deps.mediaStore, deps.utils, {
        sessionId: input.sessionId,
        pluginId: manifest.pluginId,
      })
    : undefined;
  // Trace function-runtime provider calls when a turn emitter is present. The
  // wrapper persists gateway.calling/responded/failed to trace_events; without
  // an emitter (tests, third-party direct callers) the raw gateway passes
  // through and no function.*/gateway.* events are emitted. Built before
  // imagesHandle so image generation is traced too (withGatewayTrace forwards
  // generateImage only when the source gateway has one).
  const tracedGateway =
    deps.gateway && deps.emitter
      ? withGatewayTrace(deps.gateway, deps.emitter, helperCtx)
      : deps.gateway;
  // ctx.images only when both halves of the pipeline are wired: a gateway
  // that actually exposes generateImage (older test/embedder gateways don't)
  // and a mediaStore to persist through. Either missing → undefined, so
  // handlers null-check rather than hitting a stub that always throws.
  const imagesHandle =
    tracedGateway?.generateImage && deps.mediaStore && mediaHandle
      ? createRuntimeImagesContext(
          { generateImage: tracedGateway.generateImage.bind(tracedGateway) },
          deps.mediaStore,
          mediaHandle,
          { sessionId: input.sessionId, pluginId: manifest.pluginId },
        )
      : undefined;
  // ctx.speech mirrors the ctx.images assembly: a gateway with both speech
  // halves wired plus a mediaStore to persist through, else undefined.
  const speechHandle =
    tracedGateway?.synthesizeSpeech &&
    tracedGateway?.transcribeAudio &&
    deps.mediaStore &&
    mediaHandle
      ? createRuntimeSpeechContext(
          {
            synthesizeSpeech:
              tracedGateway.synthesizeSpeech.bind(tracedGateway),
            transcribeAudio: tracedGateway.transcribeAudio.bind(tracedGateway),
          },
          deps.mediaStore,
          mediaHandle,
          { sessionId: input.sessionId, pluginId: manifest.pluginId },
        )
      : undefined;
  const isTrustedSource = isTrustedPluginSource(deps, manifest);
  const handlerStore = deps.store
    ? isTrustedSource
      ? deps.store
      : createFunctionStoreView(deps.store, helperCtx)
    : undefined;

  // Trace plugin-owned provider HTTP calls (ctx.utils.fetchWithRetry — the wire
  // image plugins use) when an emitter is present; raw passthrough otherwise.
  const tracedUtils =
    deps.utils && deps.emitter
      ? withUtilsTrace(deps.utils, deps.emitter, helperCtx)
      : deps.utils;

  await deps.emitter?.emit("function.executing", {
    ...helperCtx,
    recursionDepth,
    hasGateway: !!deps.gateway,
  });

  let output: Awaited<ReturnType<NonNullable<typeof loaded.handler>>>;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Deadline race: without it a hung handler (e.g. a provider call that
    // never resolves) blocks the whole turn forever — timeoutMs only existed
    // for the agent path before. Promise.race subscribes to the handler
    // promise, so a post-timeout rejection is still observed (no unhandled
    // rejection). ponytail: the losing handler keeps running detached — we
    // unblock the turn but can't cancel it; plumb an AbortSignal into the
    // handler ctx if detached work ever becomes a real cost.
    const handlerPromise = loaded.handler({
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      playerMessage: input.playerMessage,
      locale: input.locale,
      store: handlerStore,
      completedResults,
      config,
      recursiveCall: createRecursiveCall(),
      recursionDepth,
      ...(tracedGateway ? { gateway: tracedGateway } : {}),
      ...(tracedUtils ? { utils: tracedUtils } : {}),
      ...(mediaHandle ? { media: mediaHandle } : {}),
      ...(imagesHandle ? { images: imagesHandle } : {}),
      ...(speechHandle ? { speech: speechHandle } : {}),
      ...(assetProgress ? { assetProgress } : {}),
      ...(manualPayloadForRuntime
        ? { manualPayload: manualPayloadForRuntime }
        : {}),
      ...(triggerEvent ? { triggerEvent } : {}),
      ...(userSettingsForRuntime
        ? { userSettings: userSettingsForRuntime }
        : {}),
      ...(pluginDataHandle ? { pluginData: pluginDataHandle } : {}),
      ...(loggerHandle ? { logger: loggerHandle } : {}),
    });
    output = await Promise.race([
      handlerPromise,
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          reject(
            new Error(
              `function runtime "${manifest.name}" timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    // Function-layer terminal marker; rethrow so the dispatch catch emits the
    // single runtime.failed (avoids a double terminal event).
    await deps.emitter?.emit("function.completed", {
      ...helperCtx,
      status: "failed",
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
  }

  await deps.emitter?.emit("function.completed", {
    ...helperCtx,
    status: output.status === "suspended" ? "suspended" : "success",
    durationMs: Date.now() - startTime,
  });

  // ── Suspend detection for function runtimes (S4-T4) ────────────
  // If the handler returns { status: 'suspended', reason, resumeSchema },
  // persist a suspension and return status: 'suspended'.
  if (
    typeof output.status === "string" &&
    output.status === "suspended" &&
    typeof output.reason === "string" &&
    deps.store
  ) {
    const suspensionId = crypto.randomUUID();
    // Function runtimes have no tool loop, so suspend records carry an
    // empty pendingProposals array and no partial content.
    const suspension: SuspensionRecord = {
      id: suspensionId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      reason: output.reason as string,
      resumeSchema: output.resumeSchema ?? {},
      pendingContinuation: {
        messages: [],
        toolCallsSoFar: [],
        pendingProposals: [],
      },
      createdAt: new Date().toISOString(),
    };
    await deps.store.saveSuspension(suspension);

    emitSubEvent(deps.eventBus, "game", "turn.suspended", input.sessionId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      suspensionId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      suspendedAt: suspension.createdAt,
      reason: suspension.reason,
      resumeSchema: suspension.resumeSchema,
    });

    const suspendedResult: RuntimeResult = {
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: input.turnId,
      status: "suspended",
      output: {
        suspended: true,
        suspensionId,
        reason: suspension.reason,
        resumeSchema: suspension.resumeSchema,
      },
      toolCalls: [],
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };

    try {
      await deps.onRuntimeComplete?.({
        runtimeId: manifest.name,
        pluginId: manifest.pluginId,
        status: "suspended",
        durationMs: suspendedResult.durationMs,
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
        status: "suspended",
        durationMs: suspendedResult.durationMs,
      },
    );

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
      suspendedResult,
    );
  }

  const result: RuntimeResult = {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: "success",
    output,
    toolCalls: [],
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };

  // Save function output as TurnMessage (same as agent runtimes).
  // Manual plugin-rpc calls return their output to the caller and commit
  // proposals through plugin-rpc, so they stay out of conversation history.
  if (deps.store && !input.manualTrigger) {
    const narrativeContent =
      typeof output.narrativeOutput === "string"
        ? output.narrativeOutput
        : typeof output.content === "string"
          ? output.content
          : JSON.stringify(output);

    await deps.store.appendTurnMessage({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceType: "runtime",
      sourcePluginId: manifest.pluginId,
      sourceRuntimeId: manifest.name,
      role: "assistant",
      name: manifest.name,
      content: narrativeContent,
      order: manifest.priority ?? NARRATOR_PRIORITY,
      createdAt: new Date().toISOString(),
    });
  }

  try {
    await deps.onRuntimeComplete?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: result.status,
      durationMs: result.durationMs,
    });
  } catch {
    /* callback error must not kill runtime */
  }

  emitSubEvent(deps.eventBus, "runtime", "runtime.completed", input.sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    status: result.status,
    durationMs: result.durationMs,
  });

  // PostRuntime hook — function runtime path (S4-T3)
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
