import type {
  LoadedRuntime,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
} from "@covel/plugin-loader";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import type { DataStore, MediaStore } from "@covel/store";
import {
  createFunctionStoreView,
  createPluginDataWriter,
  createPluginLogger,
  createRuntimeMediaContext,
  processRuntimeResult,
} from "@covel/runtime";

export interface DeferredFollowerInput {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly triggerEvent: {
    readonly topic: string;
    readonly data: Readonly<Record<string, unknown>>;
  };
}

export interface DeferredFollowerJobResult {
  readonly jobId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly status: "done" | "failed";
  readonly result: RuntimeResult;
}

export interface ExpectedFollowerFailureJob {
  readonly jobId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly status: "failed";
}

function makeJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function writeExpectedFollowerFailureJob(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly turnId: string;
  readonly runtimeResults: readonly RuntimeResult[];
}): Promise<ExpectedFollowerFailureJob> {
  const jobId = makeJobId();
  const timestamp = new Date().toISOString();
  const error =
    args.runtimeResults.find((item) => item.status === "failed")?.error ??
    `runtime "${args.runtimeId}" completed without emitting a matching background follower event`;
  await args.store.setPluginData({
    id: `${args.sessionId}:${args.pluginId}:_jobs:${jobId}`,
    sessionId: args.sessionId,
    pluginId: args.pluginId,
    namespace: "_jobs",
    key: jobId,
    value: {
      status: "failed",
      runtimeId: args.runtimeId,
      turnId: args.turnId,
      startedAt: timestamp,
      completedAt: timestamp,
      error,
      runtimeResults: args.runtimeResults,
      reason: "expected-background-follower-missing",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return {
    jobId,
    runtimeId: args.runtimeId,
    pluginId: args.pluginId,
    status: "failed",
  };
}

export async function runDeferredFollower(args: {
  readonly follower: DeferredFollowerInput;
  readonly sessionId: string;
  readonly locale: string;
  readonly store: DataStore;
  readonly manifests: readonly RuntimeManifest[];
  readonly loadedCache: Map<string, LoadedRuntime>;
  readonly gateway: PluginRuntimeGateway;
  readonly mediaStore: MediaStore;
  readonly utils: PluginRuntimeUtils;
  readonly userSettings?: Record<string, unknown>;
}): Promise<DeferredFollowerJobResult> {
  const manifest = args.manifests.find(
    (item) => item.name === args.follower.runtimeId,
  );
  if (!manifest)
    throw new Error(`deferred follower not found: ${args.follower.runtimeId}`);
  const loaded = args.loadedCache.get(manifest.name);
  if (!loaded?.handler)
    throw new Error(
      `deferred follower has no handler: ${args.follower.runtimeId}`,
    );

  const jobId = makeJobId();
  const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  await args.store.setPluginData({
    id: `${args.sessionId}:${args.follower.pluginId}:_jobs:${jobId}`,
    sessionId: args.sessionId,
    pluginId: args.follower.pluginId,
    namespace: "_jobs",
    key: jobId,
    value: {
      status: "pending",
      runtimeId: args.follower.runtimeId,
      turnId,
      startedAt,
    },
    createdAt: startedAt,
    updatedAt: startedAt,
  });

  const startMs = Date.now();
  const helperCtx = {
    sessionId: args.sessionId,
    turnId,
    pluginId: args.follower.pluginId,
    runtimeId: args.follower.runtimeId,
  };
  try {
    const mediaHandle = createRuntimeMediaContext(args.mediaStore, args.utils, {
      sessionId: args.sessionId,
      pluginId: args.follower.pluginId,
    });
    const output = await loaded.handler({
      sessionId: args.sessionId,
      turnId,
      pluginId: args.follower.pluginId,
      runtimeId: args.follower.runtimeId,
      playerMessage: "",
      locale: args.locale,
      store: createFunctionStoreView(args.store, helperCtx),
      recursiveCall: async () => {
        throw new Error(
          "recursiveCall is unavailable for test-runtime deferred followers",
        );
      },
      recursionDepth: 0,
      gateway: args.gateway,
      utils: args.utils,
      media: mediaHandle,
      triggerEvent: args.follower.triggerEvent,
      ...(args.userSettings ? { userSettings: args.userSettings } : {}),
      pluginData: createPluginDataWriter(args.store, helperCtx),
      logger: createPluginLogger(args.store, helperCtx),
    });
    const outputRecord = (output ?? {}) as Record<string, unknown>;
    const failed =
      outputRecord.status === "failed" ||
      (typeof outputRecord.error === "string" && outputRecord.error.length > 0);
    const completedAt = new Date().toISOString();
    const runtimeResult: RuntimeResult = {
      runtimeId: args.follower.runtimeId,
      pluginId: args.follower.pluginId,
      runId: turnId,
      turnId,
      status: failed ? "failed" : "success",
      durationMs: Date.now() - startMs,
      output: outputRecord,
      toolCalls: [],
      timestamp: completedAt,
      ...(failed
        ? {
            error:
              typeof outputRecord.error === "string"
                ? outputRecord.error
                : "runtime reported failure",
          }
        : {}),
    };
    const processOpts = {
      capabilities: manifest.capabilities ?? [],
    };
    await processRuntimeResult(
      runtimeResult,
      args.store,
      args.sessionId,
      manifest.outputKind ?? "plugin",
      processOpts,
    );
    await args.store.setPluginData({
      id: `${args.sessionId}:${args.follower.pluginId}:_jobs:${jobId}`,
      sessionId: args.sessionId,
      pluginId: args.follower.pluginId,
      namespace: "_jobs",
      key: jobId,
      value: {
        status: failed ? "failed" : "done",
        runtimeId: args.follower.runtimeId,
        turnId,
        startedAt,
        completedAt,
        durationMs: runtimeResult.durationMs,
        ...(runtimeResult.error ? { error: runtimeResult.error } : {}),
        runtimeResults: [runtimeResult],
      },
      createdAt: startedAt,
      updatedAt: completedAt,
    });
    return {
      jobId,
      runtimeId: args.follower.runtimeId,
      pluginId: args.follower.pluginId,
      status: failed ? "failed" : "done",
      result: runtimeResult,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const runtimeResult: RuntimeResult = {
      runtimeId: args.follower.runtimeId,
      pluginId: args.follower.pluginId,
      runId: turnId,
      turnId,
      status: "failed",
      durationMs: Date.now() - startMs,
      output: {},
      toolCalls: [],
      timestamp: completedAt,
      error: error instanceof Error ? error.message : String(error),
    };
    await args.store.setPluginData({
      id: `${args.sessionId}:${args.follower.pluginId}:_jobs:${jobId}`,
      sessionId: args.sessionId,
      pluginId: args.follower.pluginId,
      namespace: "_jobs",
      key: jobId,
      value: {
        status: "failed",
        runtimeId: args.follower.runtimeId,
        turnId,
        startedAt,
        completedAt,
        error: runtimeResult.error,
        runtimeResults: [runtimeResult],
      },
      createdAt: startedAt,
      updatedAt: completedAt,
    });
    return {
      jobId,
      runtimeId: args.follower.runtimeId,
      pluginId: args.follower.pluginId,
      status: "failed",
      result: runtimeResult,
    };
  }
}
