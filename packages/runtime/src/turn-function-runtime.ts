import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import { isEnvEnabled } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { SuspensionRecord } from "@covel/store";
import {
  createPluginDataWriter,
  createPluginLogger,
  createFunctionStoreView,
} from "./plugin-handler-helpers.js";
import { createRuntimeMediaContext } from "./runtime-media-context.js";
import { runPostRuntimeHook } from "./hooks/wire-helpers.js";
import type { HookPipeline } from "./hooks/pipeline.js";
import {
  makeFailedResult,
  resolveUserSettings,
} from "./turn-executor-helpers.js";
import {
  createAssetProgressEmitter,
  emitSubEvent,
  isTrustedPluginSource,
} from "./turn-runtime-helpers.js";
import type { TurnExecutorDeps } from "./turn-executor-types.js";

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
  if (!loaded.handler) {
    return makeFailedResult(
      manifest,
      input,
      runId,
      startTime,
      "Function runtime missing handler",
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
  const helperCtx = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  };
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
  const isTrustedSource = isTrustedPluginSource(deps, manifest);
  const handlerStore = deps.store
    ? isTrustedSource
      ? deps.store
      : createFunctionStoreView(deps.store, helperCtx)
    : undefined;
  const output = await loaded.handler({
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
    ...(deps.gateway ? { gateway: deps.gateway } : {}),
    ...(deps.utils ? { utils: deps.utils } : {}),
    ...(mediaHandle ? { media: mediaHandle } : {}),
    ...(assetProgress ? { assetProgress } : {}),
    ...(manualPayloadForRuntime
      ? { manualPayload: manualPayloadForRuntime }
      : {}),
    ...(triggerEvent ? { triggerEvent } : {}),
    ...(userSettingsForRuntime ? { userSettings: userSettingsForRuntime } : {}),
    ...(pluginDataHandle ? { pluginData: pluginDataHandle } : {}),
    ...(loggerHandle ? { logger: loggerHandle } : {}),
  });

  // ── Suspend detection for function runtimes (S4-T4) ────────────
  // If the handler returns { status: 'suspended', reason, resumeSchema } and
  // COVEL_SUSPEND_V1=1, persist a suspension and return status: 'suspended'.
  if (
    isEnvEnabled("COVEL_SUSPEND_V1") &&
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
      order: manifest.priority ?? 500,
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
