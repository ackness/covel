import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  NestedTurnResult,
  RecursiveCallDelta,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { SuspensionRecord } from "@covel/store";
import {
  createPluginDataWriter,
  createPluginLogger,
  createFunctionStoreView,
  createTrustedHandlerStore,
  makeRevocableCapability,
  makeRevocableFn,
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
    delta: RecursiveCallDelta,
    opts?: { readonly reason?: string },
  ) => Promise<NestedTurnResult>;
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
      ? createTrustedHandlerStore(deps.store)
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

  // Capability revocation. The deadline race below can leave the
  // losing handler running detached; once the race settles (either way) all
  // of the handler's write/spend capabilities are revoked so a late write
  // cannot land after the session lock releases and the next turn begins.
  // The merged AbortController also gives cooperative handlers ONE signal
  // that covers both the player abort and the deadline.
  let capabilitiesRevoked = false;
  const isRevoked = () => capabilitiesRevoked;
  const handlerAbort = new AbortController();
  const playerSignal = deps.turnControl?.signal;
  if (playerSignal?.aborted) {
    handlerAbort.abort(playerSignal.reason);
  } else if (playerSignal) {
    playerSignal.addEventListener(
      "abort",
      () => handlerAbort.abort(playerSignal.reason),
      { once: true },
    );
  }

  const revocable = {
    store: handlerStore
      ? makeRevocableCapability(handlerStore, isRevoked, "store")
      : undefined,
    pluginData: pluginDataHandle
      ? makeRevocableCapability(pluginDataHandle, isRevoked, "pluginData")
      : undefined,
    media: mediaHandle
      ? makeRevocableCapability(mediaHandle, isRevoked, "media")
      : undefined,
    images: imagesHandle
      ? makeRevocableCapability(imagesHandle, isRevoked, "images")
      : undefined,
    speech: speechHandle
      ? makeRevocableCapability(speechHandle, isRevoked, "speech")
      : undefined,
    gateway: tracedGateway
      ? makeRevocableCapability(tracedGateway, isRevoked, "gateway")
      : undefined,
    utils: tracedUtils
      ? makeRevocableCapability(tracedUtils, isRevoked, "utils")
      : undefined,
    recursiveCall: makeRevocableFn(
      createRecursiveCall(),
      isRevoked,
      "recursiveCall",
    ),
    // logger persists to the store and assetProgress emits SSE/trace events —
    // both are side-effecting, so they belong in the revocation set too —
    // otherwise a timed-out handler keeps appending log rows and emitting
    // progress events after its turn is over.
    logger: loggerHandle
      ? makeRevocableCapability(loggerHandle, isRevoked, "logger")
      : undefined,
    assetProgress: assetProgress
      ? makeRevocableFn(assetProgress, isRevoked, "assetProgress")
      : undefined,
  };
  // ponytail: revocation is checked at call entry, so an effect already
  // in flight when the deadline fires still lands. Closing that needs the
  // deadline signal threaded into every primitive (or worker isolation) —
  // upgrade path if late in-flight writes show up in practice.

  let output: Awaited<ReturnType<NonNullable<typeof loaded.handler>>>;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Deadline race: without it a hung handler (e.g. a provider call that
    // never resolves) blocks the whole turn forever — timeoutMs only existed
    // for the agent path before. Promise.race subscribes to the handler
    // promise, so a post-timeout rejection is still observed (no unhandled
    // rejection). The merged abort signal (ctx.signal) lets a cooperative
    // handler cancel its own in-flight provider work; a NON-cooperative
    // losing handler keeps running detached, but its capabilities are
    // revoked in the finally below so late writes are rejected.
    const handlerPromise = loaded.handler({
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      playerMessage: input.playerMessage,
      locale: input.locale,
      store: revocable.store,
      completedResults,
      recursiveCall: revocable.recursiveCall,
      recursionDepth,
      ...(revocable.gateway ? { gateway: revocable.gateway } : {}),
      ...(revocable.utils ? { utils: revocable.utils } : {}),
      ...(revocable.media ? { media: revocable.media } : {}),
      ...(revocable.images ? { images: revocable.images } : {}),
      ...(revocable.speech ? { speech: revocable.speech } : {}),
      ...(revocable.assetProgress
        ? { assetProgress: revocable.assetProgress }
        : {}),
      ...(manualPayloadForRuntime
        ? { manualPayload: manualPayloadForRuntime }
        : {}),
      ...(triggerEvent ? { triggerEvent } : {}),
      ...(userSettingsForRuntime
        ? { userSettings: userSettingsForRuntime }
        : {}),
      ...(revocable.pluginData ? { pluginData: revocable.pluginData } : {}),
      ...(revocable.logger ? { logger: revocable.logger } : {}),
      signal: handlerAbort.signal,
    });
    output = await Promise.race([
      handlerPromise,
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          const err = new Error(
            `function runtime "${manifest.name}" timed out after ${timeoutMs}ms`,
          );
          handlerAbort.abort(err);
          reject(err);
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
    // The race has settled — no further capability use is legitimate,
    // whether the handler won (its output is final) or lost (it is detached).
    capabilitiesRevoked = true;
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

  const rawResult: RuntimeResult = {
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

  // PostRuntime hook — function runtime path. Runs BEFORE
  // persistence so prompt history, commit proposals, and SSE all see
  // the same finalized output — see the agent-path comment for rationale.
  const result = await runPostRuntimeHook(
    {
      pipeline: hookPipeline,
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    },
    rawResult,
  );
  const finalOutput = (result.output ?? output) as Record<string, unknown>;

  // Save function output as TurnMessage (same as agent runtimes).
  // Manual plugin-rpc calls return their output to the caller and commit
  // proposals through plugin-rpc, so they stay out of conversation history.
  // Skipped when a PostRuntime hook rewrote the status to a non-success.
  if (deps.store && !input.manualTrigger && result.status === "success") {
    const narrativeContent =
      typeof finalOutput.narrativeOutput === "string"
        ? finalOutput.narrativeOutput
        : typeof finalOutput.content === "string"
          ? finalOutput.content
          : JSON.stringify(finalOutput);

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

  return result;
}
