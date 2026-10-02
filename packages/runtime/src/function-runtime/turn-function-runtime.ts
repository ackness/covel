import { snapshotPlayerInput } from "../turn-executor/turn-digest.js";
import { toJsonValueOrDiagnostic } from "@covel/shared";
import { createWorldModelView } from "./world-model-view.js";
import { reportRuntimeStarted } from "../trace/runtime-telemetry.js";
import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  NestedTurnResult,
  RecursiveCallDelta,
  RuntimeActivation,
  ExecutionContext,
  InputSlot,
} from "@covel/shared";
import { attachRuntimeJournal } from "../execution-journal.js";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import type { SuspensionRecord } from "@covel/store";
import { validateOutput, getToolContent } from "@covel/tools";
import {
  createPluginDataWriter,
  createPluginLogger,
  createFunctionStoreView,
  createTrustedHandlerStore,
  makeRevocableCapability,
  makeRevocableFn,
} from "./plugin-handler-helpers.js";
import { createExecutionWriteBuffer } from "./execution-write-buffer.js";
import { normalizeHandlerResult } from "../commit/normalize-handler-result.js";
import { materializeHandlerSuccess } from "../commit/materialize-handler-output.js";
import { collectUiBlocks } from "../session/session-kernel-helpers.js";
import { createRuntimeMediaContext } from "./runtime-media-context.js";
import { createRuntimeImagesContext } from "./runtime-images-context.js";
import { createRuntimeSpeechContext } from "./runtime-speech-context.js";
import { createProgressReporter } from "../job-status/job-status.js";
import { finalizeRuntimeResult } from "../turn-executor/runtime-finalization.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import {
  makeFailedResult,
  resolveUserSettings,
} from "../turn-executor/turn-executor-helpers.js";
import {
  createAssetProgressEmitter,
  isTrustedPluginSource,
} from "../turn-executor/turn-runtime-helpers.js";
import { withGatewayTrace } from "./gateway-trace.js";
import { withUtilsTrace } from "./utils-trace.js";
import { createRuntimeTools } from "./runtime-tools.js";
import { enforceHttpPermissions } from "./http-permissions.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import {
  getTurnExecutionSignal,
  RuntimeTimeoutError,
} from "../turn-executor/turn-control.js";
import {
  withDefaultGatewaySignal,
  withDefaultUtilsSignal,
} from "./runtime-abort-boundaries.js";
import { attachSuspensionArtifact } from "../suspension-artifact.js";
import { freezeInputSlots } from "../agent-loop/runtime-input-slots.js";
import { deepFreeze } from "../hooks/hook-settings.js";

export interface ExecuteFunctionRuntimeOptions {
  readonly lastPlayerInput?:
    import("@covel/shared").PlayerInputSubmission | null;
  readonly upstreamProposals?: readonly import("@covel/shared").Proposal[];
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly deps: TurnExecutorDeps;
  readonly hookPipeline: HookPipeline | undefined;
  readonly triggerEvent:
    | {
        readonly topic: string;
        readonly data: Readonly<Record<string, unknown>>;
      }
    | undefined;
  /** Canonical activation for this run — exposed as `ctx.activation`. */
  readonly activation?: RuntimeActivation;
  /** Resolved provenance-wrapped input bindings — exposed as `ctx.inputs`. */
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  /** Frozen cross-execution `recordAs` exports — exposed as `ctx.exports`. */
  readonly exports?: Readonly<Record<string, InputSlot>>;
  /** Full execution identity — exposed as `ctx.execution`. */
  readonly executionContext: ExecutionContext;
  readonly createRecursiveCall: (
    parentSignal?: AbortSignal,
  ) => (
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
  /**
   * Execution identity of this scheduling run — the default `progressScopeId`
   * for `ctx.progress`. Absent for entry points that don't thread an
   * `ExecutionContext` (thin test harnesses); the reporter falls back to the
   * turnId scope in that case.
   */
  readonly executionId?: string;
  /** Resume payload for a previously suspended function runtime. */
  readonly resumeData?: unknown;
  /** Identifies a resume invocation even when `resumeData` is undefined. */
  readonly resumedFromSuspensionId?: string;
  /** Uncommitted writes captured by the suspended invocation. */
  readonly pendingProposals?: readonly import("@covel/shared").Proposal[];
  /** Resume forbids creating a second nested suspension. Defaults to true. */
  readonly allowSuspend?: boolean;
}

export async function executeFunctionRuntime({
  lastPlayerInput = null,
  upstreamProposals = [],
  manifest,
  input,
  loaded,
  deps,
  hookPipeline,
  triggerEvent,
  activation: originalActivation,
  inputs: originalInputs,
  exports: originalExports,
  executionContext,
  createRecursiveCall,
  recursionDepth,
  startTime,
  runId,
  timeoutMs,
  executionId,
  resumeData,
  resumedFromSuspensionId,
  pendingProposals = [],
  allowSuspend = true,
}: ExecuteFunctionRuntimeOptions): Promise<RuntimeResult> {
  const inputs = originalInputs ? freezeInputSlots(originalInputs) : undefined;
  const exportSlots = originalExports
    ? freezeInputSlots(originalExports)
    : undefined;
  const activation = originalActivation
    ? deepFreeze(structuredClone(originalActivation))
    : undefined;
  // Emit start for function runtimes (no guard to check)
  await reportRuntimeStarted(deps, input.sessionId, manifest, {
    turnId: input.turnId,
    runId,
  });

  const helperCtx = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  };

  // Execution write buffer: ctx.pluginData / ctx.store domain writes route
  // through this instead of hitting the store directly, and flush onto the
  // result pendingProposals at execution end so they commit in finalizeExecution's
  // single transaction (and roll back with it if the handler fails).
  const writeBuffer = createExecutionWriteBuffer();
  writeBuffer.push(...structuredClone(pendingProposals));

  if (!loaded.handler) {
    return finalizeRuntimeResult(
      { ...deps, hookPipeline },
      manifest,
      input,
      makeFailedResult(
        manifest,
        input,
        runId,
        startTime,
        "Function runtime missing handler",
      ),
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
  // One signal covers player aborts, inherited parent deadlines, and this
  // runtime's own deadline. Provider and HTTP facades apply it by default so
  // plugins do not need to remember to forward ctx.signal themselves.
  const handlerAbort = new AbortController();
  const turnExecutionSignal = getTurnExecutionSignal(deps.turnControl);
  const relayTurnAbort = () => handlerAbort.abort(turnExecutionSignal?.reason);
  if (turnExecutionSignal?.aborted) {
    relayTurnAbort();
  } else if (turnExecutionSignal) {
    turnExecutionSignal.addEventListener("abort", relayTurnAbort, {
      once: true,
    });
  }
  const runtimeGateway = deps.gateway
    ? withDefaultGatewaySignal(deps.gateway, handlerAbort.signal)
    : undefined;
  const runtimeUtils = deps.utils
    ? withDefaultUtilsSignal(deps.utils, handlerAbort.signal)
    : undefined;
  const assetProgress = createAssetProgressEmitter(deps.emitter, helperCtx);
  const pluginDataHandle = deps.store
    ? createPluginDataWriter(deps.store, helperCtx, writeBuffer)
    : undefined;
  const loggerHandle = deps.store
    ? createPluginLogger(deps.store, helperCtx)
    : undefined;
  // Real-time job-status channel. Scoped to this execution (progressScopeId =
  // executionId) so a job cannot be spoofed across executions; falls back to
  // the turnId scope when no ExecutionContext was threaded (test harnesses).
  const progressHandle = deps.store
    ? createProgressReporter({
        store: deps.store,
        eventBus: deps.eventBus,
        sessionId: input.sessionId,
        progressScopeId: executionId ?? input.turnId,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        // Canonicalize + ownership-check MediaRefs in job `data` reports.
        ...(deps.mediaStore ? { mediaStore: deps.mediaStore } : {}),
      })
    : undefined;
  const isTrustedSource = isTrustedPluginSource(deps, manifest);
  // Community HTTP fail-closed: a community plugin may only reach an
  // origin+method declared under permissions.http; trusted plugins pass through
  // unchanged (SSRF still enforced inside fetchWithRetry either way). Built
  // BEFORE the media/images/speech handles so `ctx.media.ingestUrl` (and every
  // URL a gateway result asks us to ingest) is subject to the same allowlist as
  // `ctx.utils.fetchWithRetry`, and BEFORE the trace wrapper so a denied call
  // never emits a spurious calling event; enforcement is not trace-gated.
  const permissionedUtils = runtimeUtils
    ? enforceHttpPermissions(runtimeUtils, {
        isCommunity: !isTrustedSource,
        httpPermissions: manifest.permissions?.http ?? [],
        runtimeId: manifest.name,
      })
    : undefined;
  const mediaHandle = deps.mediaStore
    ? createRuntimeMediaContext(deps.mediaStore, permissionedUtils, {
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
    runtimeGateway && deps.emitter
      ? withGatewayTrace(runtimeGateway, deps.emitter, helperCtx)
      : runtimeGateway;
  // ctx.images only when both halves of the pipeline are wired: a gateway
  // that actually exposes generateImage (older test/embedder gateways don't)
  // and a mediaStore to persist through. Either missing → undefined, so
  // handlers null-check rather than hitting a stub that always throws.
  const imagesHandle =
    tracedGateway?.generateImage && deps.mediaStore && mediaHandle
      ? createRuntimeImagesContext(
          {
            generateImage: tracedGateway.generateImage.bind(tracedGateway),
            resolveSlot: tracedGateway.resolveSlot.bind(tracedGateway),
          },
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
  const world = deps.store
    ? await createWorldModelView(
        deps.worldModelReads ?? deps.store,
        input.sessionId,
        upstreamProposals,
        writeBuffer,
        () => handlerAbort.signal.throwIfAborted(),
        deps.dimensionContext,
      )
    : undefined;
  const handlerStore = deps.store
    ? isTrustedSource
      ? createTrustedHandlerStore(deps.store, helperCtx, writeBuffer, world)
      : createFunctionStoreView(deps.store, helperCtx, writeBuffer)
    : createFunctionStoreView(undefined, helperCtx);

  // Trace plugin-owned provider HTTP calls (ctx.utils.fetchWithRetry — the wire
  // image plugins use) when an emitter is present; raw passthrough otherwise.
  const tracedUtils =
    permissionedUtils && deps.emitter
      ? withUtilsTrace(permissionedUtils, deps.emitter, helperCtx)
      : permissionedUtils;

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
  const runtimeTools = createRuntimeTools({
    manifest,
    context: helperCtx,
    deps: { ...deps, hookPipeline },
    buffer: writeBuffer,
    world,
    upstreamProposals,
    inputs,
    signal: handlerAbort.signal,
    assertLive: () => {
      if (capabilitiesRevoked)
        throw new Error("function runtime tools capability is revoked");
    },
  });
  const inFlightRecursiveCalls = new Set<Promise<unknown>>();
  const rawRecursiveCall = createRecursiveCall(handlerAbort.signal);
  const trackedRecursiveCall: typeof rawRecursiveCall = (delta, opts) => {
    const call = rawRecursiveCall(delta, opts);
    inFlightRecursiveCalls.add(call);
    void call.then(
      () => inFlightRecursiveCalls.delete(call),
      () => inFlightRecursiveCalls.delete(call),
    );
    return call;
  };
  const drainRecursiveCalls = async (): Promise<void> => {
    while (inFlightRecursiveCalls.size > 0) {
      await Promise.allSettled(inFlightRecursiveCalls);
    }
  };

  const revocable = {
    store: makeRevocableCapability(handlerStore, isRevoked, "store"),
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
      trackedRecursiveCall,
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
    // Progress reports append to the store and emit SSE — side-effecting, so
    // revoked with the rest once the deadline race settles. The finalizer uses
    // the raw (un-revoked) reporter, not this handle.
    progress: progressHandle
      ? makeRevocableCapability(progressHandle, isRevoked, "progress")
      : undefined,
  };
  const serviceClient = deps.services?.createClient({
    emitter: deps.emitter,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    signal: handlerAbort.signal,
    gateway: revocable.gateway,
    utils: revocable.utils,
  });
  const services = serviceClient
    ? makeRevocableCapability(serviceClient, isRevoked, "services")
    : undefined;
  // ponytail: revocation is checked at call entry, so an effect already
  // in flight when the deadline fires still lands. Closing that needs the
  // deadline signal threaded into every primitive (or worker isolation) —
  // upgrade path if late in-flight writes show up in practice.

  let output: Awaited<ReturnType<NonNullable<typeof loaded.handler>>>;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
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
      session: {
        lastPlayerInput: snapshotPlayerInput(lastPlayerInput),
      },
      locale: input.locale,
      store: revocable.store,
      world,
      tools: runtimeTools.tools,
      ...(services ? { services } : {}),
      ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
      ...(exportSlots && Object.keys(exportSlots).length > 0
        ? { exports: exportSlots }
        : {}),
      ...(activation ? { activation } : {}),
      execution: executionContext,
      ...(resumedFromSuspensionId !== undefined
        ? { resumeData, resumedFromSuspensionId }
        : {}),
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
      ...(revocable.progress ? { progress: revocable.progress } : {}),
      signal: handlerAbort.signal,
    });
    const handlerWork = handlerPromise.then(async (result) => {
      // A handler may intentionally launch a recursive call without awaiting
      // it. Keep the invocation lease until all nested turns have settled.
      await drainRecursiveCalls();
      await runtimeTools.drain();
      return result;
    });
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => {
        // Revoke synchronously with the abort so no capability call can enter
        // during the Promise.race rejection microtask window.
        capabilitiesRevoked = true;
        const reason = handlerAbort.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error(`function runtime "${manifest.name}" was aborted`),
        );
      };
      if (handlerAbort.signal.aborted) {
        onAbort();
        return;
      }
      handlerAbort.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        handlerAbort.signal.removeEventListener("abort", onAbort);
    });
    output = await Promise.race([
      handlerWork,
      aborted,
      new Promise<never>(() => {
        deadlineTimer = setTimeout(() => {
          const err = new RuntimeTimeoutError(
            `function runtime "${manifest.name}" timed out after ${timeoutMs}ms`,
          );
          handlerAbort.abort(err);
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
    removeAbortListener?.();
    turnExecutionSignal?.removeEventListener("abort", relayTurnAbort);
    // The race has settled — no further capability use is legitimate,
    // whether the handler won (its output is final) or lost (it is detached).
    capabilitiesRevoked = true;
    if (!handlerAbort.signal.aborted) {
      handlerAbort.abort(
        new Error(`function runtime "${manifest.name}" completed`),
      );
    }
    await drainRecursiveCalls();
  }

  const { outcome: handlerOutcome, diagnostics } = normalizeHandlerResult(
    getToolContent(output),
  );
  for (const diagnostic of diagnostics) {
    console.warn(
      `[runtime] ${manifest.name}: ${diagnostic.code} — ${diagnostic.message}`,
    );
  }

  await deps.emitter?.emit("function.completed", {
    ...helperCtx,
    status:
      handlerOutcome.outcome === "success" ? "success" : handlerOutcome.outcome,
    durationMs: Date.now() - startTime,
  });

  // ── Suspend detection for function runtimes ────────────
  // A resume invocation must not create a second suspension record.
  if (handlerOutcome.outcome === "suspended" && allowSuspend) {
    const suspensionId = crypto.randomUUID();
    // Keep domain writes uncommitted until resume succeeds. The continuation
    // also owns the original binding snapshots rather than resolving them again.
    const suspension: SuspensionRecord = {
      id: suspensionId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      reason: handlerOutcome.reason,
      resumeSchema: handlerOutcome.resumeSchema ?? {},
      pendingContinuation: {
        messages: [],
        toolCallsSoFar: [],
        pendingProposals: structuredClone(writeBuffer),
        ...(inputs ? { inputSlots: structuredClone(inputs) } : {}),
        ...(exportSlots ? { exportSlots: structuredClone(exportSlots) } : {}),
        ...(activation ? { activation: structuredClone(activation) } : {}),
        emittedEvents: [],
        executionContext,
      },
      createdAt: new Date().toISOString(),
    };
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

    const finalResult = await finalizeRuntimeResult(
      { ...deps, hookPipeline },
      manifest,
      input,
      suspendedResult,
    );
    return finalResult.status === "suspended"
      ? attachSuspensionArtifact(finalResult, { record: suspension })
      : finalResult;
  }

  // `output.schema` validates the canonical success value. A mismatch fails
  // the runtime and commits no domain effects.
  let envelopeSchemaError: string | undefined;
  if (loaded.outputSchema && handlerOutcome.outcome === "success") {
    const validation = validateOutput(
      handlerOutcome.value,
      loaded.outputSchema,
    );
    if (!validation.valid) {
      const errors = validation.errors ?? ["unknown schema validation error"];
      const detail = errors.slice(0, 5).join("; ");
      envelopeSchemaError = `output-schema-invalid: ${detail}`;
    }
  }

  const materialized: Pick<RuntimeResult, "output" | "effects" | "completion"> =
    !envelopeSchemaError && handlerOutcome.outcome === "success"
      ? materializeHandlerSuccess(handlerOutcome, output)
      : {
          output: getToolContent(output) as unknown as Record<string, unknown>,
          ...(!envelopeSchemaError &&
          (handlerOutcome.outcome === "failed" ||
            handlerOutcome.outcome === "skipped") &&
          handlerOutcome.effects
            ? { effects: structuredClone(handlerOutcome.effects) }
            : {}),
        };

  let effects = materialized.effects;

  if (
    !envelopeSchemaError &&
    handlerOutcome.outcome === "success" &&
    runtimeTools.events.length > 0
  ) {
    effects = {
      ...effects,
      events: [
        ...(Array.isArray(effects?.events) ? effects.events : []),
        ...runtimeTools.events.map((event) =>
          toJsonValueOrDiagnostic(event, "event"),
        ),
      ],
    };
  }
  if (!envelopeSchemaError && handlerOutcome.outcome === "success") {
    const ui = collectUiBlocks({ ui: effects?.ui }, runtimeTools.records);
    if (ui.length > 0)
      effects = { ...effects, ui: ui as import("@covel/shared").JsonValue[] };
  }

  // A failed schema gate overrides the handler outcome: the runtime
  // fails with `output-schema-invalid` and no domain effects are committed.
  const rawResult: RuntimeResult = {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: envelopeSchemaError
      ? "failed"
      : handlerOutcome.outcome === "success"
        ? "success"
        : handlerOutcome.outcome,
    ...materialized,
    ...(effects ? { effects } : {}),
    ...(handlerOutcome.outcome === "success"
      ? {
          canonicalValue:
            handlerOutcome.value === undefined
              ? {}
              : { value: structuredClone(handlerOutcome.value) },
        }
      : {}),
    toolCalls: runtimeTools.records,
    durationMs: Date.now() - startTime,
    ...(envelopeSchemaError
      ? { error: envelopeSchemaError }
      : handlerOutcome.outcome === "failed"
        ? { error: handlerOutcome.error }
        : {}),
    timestamp: new Date().toISOString(),
  };

  const result = await finalizeRuntimeResult(
    { ...deps, hookPipeline },
    manifest,
    input,
    rawResult,
    {
      outputContractSchema: loaded.outputContractSchema,
      outputSchema: loaded.outputSchema,
    },
  );

  // Keep commands separate from business output; copying the result preserves them.
  const completedResult: RuntimeResult =
    result.status === "success" && writeBuffer.length > 0
      ? {
          ...result,
          pendingProposals: [
            ...(result.pendingProposals ?? []),
            ...writeBuffer,
          ],
        }
      : result;

  const finalOutput = (completedResult.output ??
    getToolContent(output)) as Record<string, unknown>;

  if (deps.store)
    attachRuntimeJournal(completedResult, input, manifest, finalOutput);

  return completedResult;
}
