/**
 * The context a function handler and an agent guard receive. Both get the
 * same fields under the same rules, whatever the plugin's source: a bundled
 * plugin has no capability a community plugin lacks. Source changes only
 * what the security rules require (a community plugin's HTTP calls must
 * match its `permissions.http`).
 */
import { withRuntimeTextDefaults } from "./plugin-runtime-gateway.js";
import { snapshotPlayerInput } from "../turn-executor/turn-digest.js";
import { pluginMessagesFor } from "@covel/shared";
import type {
  ExecutionContext,
  InputSlot,
  NestedTurnResult,
  PlayerInputSubmission,
  Proposal,
  RecursiveCallDelta,
  RuntimeActivation,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import type {
  FunctionHandlerContext,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import { createWorldModelView } from "./world-model-view.js";
import {
  createFunctionStoreView,
  createPluginDataWriter,
  createPluginLogger,
  makeRevocableCapability,
  makeRevocableFn,
  type HandlerHelperContext,
} from "./plugin-handler-helpers.js";
import type { ExecutionWriteBuffer } from "./execution-write-buffer.js";
import type { PluginDataVisibility } from "./upstream-plugin-data.js";
import {
  createRuntimeMediaContext,
  createRuntimeMediaWriter,
} from "./runtime-media-context.js";
import { createRuntimeImagesContext } from "./runtime-images-context.js";
import { createRuntimeMusicContext } from "./runtime-music-context.js";
import { createRuntimeSpeechContext } from "./runtime-speech-context.js";
import { createProgressReporter } from "../job-status/job-status.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import { resolveUserSettings } from "../turn-executor/turn-executor-helpers.js";
import {
  createAssetProgressEmitter,
  isTrustedPluginSource,
} from "../turn-executor/turn-runtime-helpers.js";
import { withGatewayTrace } from "./gateway-trace.js";
import {
  promptCacheKeyFor,
  withPromptCacheKey,
} from "../llm/prompt-cache-key.js";
import { withUtilsTrace } from "./utils-trace.js";
import { createRuntimeTools } from "./runtime-tools.js";
import { createPluginRandom } from "./plugin-random.js";
import { enforceHttpPermissions } from "./http-permissions.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { getTurnExecutionSignal } from "../turn-executor/turn-control.js";
import {
  withDefaultGatewaySignal,
  withStalledCallRetry,
  withDefaultUtilsSignal,
} from "./runtime-abort-boundaries.js";

export interface PluginRuntimeContextOptions {
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
  readonly lastPlayerInput: PlayerInputSubmission | null;
  readonly logicalTurn?: number;
  readonly upstreamProposals: readonly Proposal[];
  /** Frozen activation, inputs and exports of this run. */
  readonly activation?: RuntimeActivation;
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  readonly exports?: Readonly<Record<string, InputSlot>>;
  /** Full execution identity; the context exposes only its public part. */
  readonly executionContext: ExecutionContext;
  readonly resumeData?: unknown;
  readonly resumedFromSuspensionId?: string;
  readonly createRecursiveCall: (
    parentSignal?: AbortSignal,
  ) => (
    delta: RecursiveCallDelta,
    opts?: { readonly reason?: string },
  ) => Promise<NestedTurnResult>;
  readonly recursionDepth: number;
  readonly startTime: number;
  readonly timeoutMs: number;
  /** Default `progressScopeId` for `ctx.progress`; the turn ID when absent. */
  readonly executionId?: string;
  /** Domain writes collect here and commit with the execution. */
  readonly writeBuffer: ExecutionWriteBuffer;
  /**
   * Upstream writes of the same plugin that reads include, and the recorder
   * of what those reads saw. Shared by `ctx.pluginData`, `ctx.store` and
   * `ctx.tools`; absent, reads see the store and the buffer only.
   */
  readonly pluginDataVisibility?: PluginDataVisibility;
}

export interface PluginRuntimeContext {
  /** What the handler or guard receives. */
  readonly context: FunctionHandlerContext;
  /** Aborted by a player abort, the deadline, or completion. */
  readonly abort: AbortController;
  /** Tool calls and events made through `ctx.tools`. */
  readonly tools: ReturnType<typeof createRuntimeTools>;
  /**
   * Kernel-held results of the nested executions this invocation started.
   * Like the write buffer, they commit only when attached to the result of a
   * handler that succeeded on its own (`attachNestedResults`).
   */
  readonly nestedResults: readonly RuntimeResult[];
  /** Upstream producer ids whose writes this invocation's reads saw. */
  readDependencies(): readonly string[];
  /** Revoke every capability; a later call throws. */
  revoke(): void;
  /** Wait for nested turns and tool calls the plugin did not await. */
  drain(): Promise<void>;
  /** Stop relaying the turn's abort to {@link abort}. */
  dispose(): void;
}

export async function createPluginRuntimeContext({
  manifest,
  input,
  loaded,
  deps,
  hookPipeline,
  triggerEvent,
  lastPlayerInput,
  logicalTurn,
  upstreamProposals,
  activation,
  inputs,
  exports: exportSlots,
  executionContext,
  resumeData,
  resumedFromSuspensionId,
  createRecursiveCall,
  startTime,
  timeoutMs,
  executionId,
  writeBuffer,
  pluginDataVisibility,
  recursionDepth,
}: PluginRuntimeContextOptions): Promise<PluginRuntimeContext> {
  const helperCtx: HandlerHelperContext = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  };
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
    ? withPromptCacheKey(
        withDefaultGatewaySignal(
          withRuntimeTextDefaults(
            deps.gateway,
            input.locale,
            manifest.runtimeType === "function" ? manifest.model : undefined,
          ),
          handlerAbort.signal,
        ),
        promptCacheKeyFor(input.sessionId, manifest.name),
      )
    : undefined;
  const runtimeUtils = deps.utils
    ? withDefaultUtilsSignal(deps.utils, handlerAbort.signal)
    : undefined;
  const assetProgress = createAssetProgressEmitter(deps.emitter, helperCtx);
  const pluginDataHandle = deps.store
    ? createPluginDataWriter(
        deps.store,
        helperCtx,
        writeBuffer,
        pluginDataVisibility,
      )
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
  const mediaOptions = {
    sessionId: input.sessionId,
    pluginId: manifest.pluginId,
    signal: handlerAbort.signal,
  };
  const mediaHandle = deps.mediaStore
    ? createRuntimeMediaContext(
        deps.mediaStore,
        permissionedUtils,
        mediaOptions,
      )
    : undefined;
  // Trace function-runtime provider calls when a turn emitter is present. The
  // wrapper persists gateway.calling/responded/failed to trace_events; without
  // an emitter (tests, third-party direct callers) the raw gateway passes
  // through and no function.*/gateway.* events are emitted. Built before
  // imagesHandle so image generation is traced too (withGatewayTrace forwards
  // generateImage only when the source gateway has one).
  const observedGateway =
    runtimeGateway && deps.emitter
      ? withGatewayTrace(runtimeGateway, deps.emitter, helperCtx)
      : runtimeGateway;
  // Outside the trace, so a call that stalled and its second attempt are two
  // traced calls.
  const tracedGateway = observedGateway
    ? withStalledCallRetry(observedGateway, {
        deadline: startTime + timeoutMs,
        runtimeId: manifest.name,
      })
    : undefined;
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
          createRuntimeMediaWriter(
            deps.mediaStore,
            permissionedUtils,
            mediaOptions,
          ),
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
            resolveSlot: tracedGateway.resolveSlot.bind(tracedGateway),
          },
          deps.mediaStore,
          mediaHandle,
          { sessionId: input.sessionId, pluginId: manifest.pluginId },
        )
      : undefined;
  // ctx.music: the same assembly; present only when the host can generate.
  const musicHandle =
    tracedGateway?.composeMusic && deps.mediaStore && mediaHandle
      ? createRuntimeMusicContext(
          {
            composeMusic: tracedGateway.composeMusic.bind(tracedGateway),
            resolveSlot: tracedGateway.resolveSlot.bind(tracedGateway),
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
    ? createFunctionStoreView(
        deps.store,
        helperCtx,
        writeBuffer,
        pluginDataVisibility,
      )
    : createFunctionStoreView(undefined, helperCtx);

  // Trace plugin-owned provider HTTP calls (ctx.utils.fetchWithRetry — the wire
  // image plugins use) when an emitter is present; raw passthrough otherwise.
  const tracedUtils =
    permissionedUtils && deps.emitter
      ? withUtilsTrace(permissionedUtils, deps.emitter, helperCtx)
      : permissionedUtils;

  // Capability revocation. The deadline race below can leave the
  // losing handler running detached; once the race settles (either way) all
  // of the handler's write/spend capabilities are revoked so a late write
  // cannot land after the session lock releases and the next turn begins.
  // The merged AbortController also gives cooperative handlers ONE signal
  // that covers both the player abort and the deadline.
  let capabilitiesRevoked = false;
  const isRevoked = () => capabilitiesRevoked;
  // The plugin's translations for this session's language.
  const messages = pluginMessagesFor(loaded.messages, input.locale);
  const runtimeTools = createRuntimeTools({
    manifest,
    context: helperCtx,
    ...(logicalTurn !== undefined ? { logicalTurn } : {}),
    locale: input.locale,
    messages,
    deps: { ...deps, hookPipeline },
    buffer: writeBuffer,
    ...(pluginDataVisibility ? { pluginDataVisibility } : {}),
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
  const nestedResults: RuntimeResult[] = [];
  const rawRecursiveCall = createRecursiveCall(handlerAbort.signal);
  const trackedRecursiveCall: typeof rawRecursiveCall = (delta, opts) => {
    const call = rawRecursiveCall(delta, opts).then((nested) => {
      // The plugin gets a copy; the kernel keeps and commits the originals,
      // so mutating the returned value cannot change what commits or who
      // owns it.
      const copy = structuredClone(nested);
      nestedResults.push(...nested.runtimeResults);
      return copy;
    });
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
    music: musicHandle
      ? makeRevocableCapability(musicHandle, isRevoked, "music")
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
    reads: {
      locale: input.locale,
      world,
      store: deps.store,
      visibility: pluginDataVisibility,
      writeBuffer,
    },
  });
  const services = serviceClient
    ? makeRevocableCapability(serviceClient, isRevoked, "services")
    : undefined;
  // ponytail: revocation is checked at call entry, so an effect already
  // in flight when the deadline fires still lands. Closing that needs the
  // deadline signal threaded into every primitive (or worker isolation) —
  // upgrade path if late in-flight writes show up in practice.

  const context: FunctionHandlerContext = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    playerMessage: input.playerMessage,
    playerActions: input.actions ?? [],
    ...(logicalTurn !== undefined ? { logicalTurn } : {}),
    session: {
      lastPlayerInput: snapshotPlayerInput(lastPlayerInput),
    },
    locale: input.locale,
    ...(messages ? { messages } : {}),
    store: revocable.store,
    world,
    tools: runtimeTools.tools,
    ...(services ? { services } : {}),
    ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(exportSlots && Object.keys(exportSlots).length > 0
      ? { exports: exportSlots }
      : {}),
    ...(activation ? { activation } : {}),
    // The public identity only; counting and ledger keys stay in the kernel.
    execution: {
      origin: executionContext.origin,
      ...(executionContext.sourceTurnId !== undefined
        ? { sourceTurnId: executionContext.sourceTurnId }
        : {}),
    },
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
    ...(revocable.music ? { music: revocable.music } : {}),
    ...(revocable.assetProgress
      ? { assetProgress: revocable.assetProgress }
      : {}),
    ...(manualPayloadForRuntime
      ? { manualPayload: manualPayloadForRuntime }
      : {}),
    ...(triggerEvent ? { triggerEvent } : {}),
    ...(userSettingsForRuntime ? { userSettings: userSettingsForRuntime } : {}),
    ...(revocable.pluginData ? { pluginData: revocable.pluginData } : {}),
    ...(revocable.logger ? { logger: revocable.logger } : {}),
    ...(revocable.progress ? { progress: revocable.progress } : {}),
    random: createPluginRandom({ ...helperCtx, stream: manifest.name }),
    signal: handlerAbort.signal,
  };
  return {
    context,
    abort: handlerAbort,
    tools: runtimeTools,
    nestedResults,
    readDependencies: () => [...(pluginDataVisibility?.recorder ?? [])],
    revoke: () => {
      capabilitiesRevoked = true;
    },
    drain: async () => {
      await drainRecursiveCalls();
      await runtimeTools.drain();
    },
    dispose: () =>
      turnExecutionSignal?.removeEventListener("abort", relayTurnAbort),
  };
}
