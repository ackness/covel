import type {
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  buildHookSettings,
  collectExecutionJournal,
  collectExecutionSuspensions,
  commitExecution,
  executeTurn,
  snapshotUserSettings,
  type TurnExecutorDeps,
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
  readonly runtimeResults: readonly RuntimeResult[];
  readonly deferredFollowers: readonly DeferredFollowerInput[];
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

/** Commit one isolated author-tool execution through the host's finalizer. */
export async function commitDebugExecution(args: {
  readonly turn: TurnResult;
  readonly manifests: readonly RuntimeManifest[];
  readonly deps: TurnExecutorDeps & { readonly store: DataStore };
  readonly locale: string;
  readonly userSettings: TurnInput["userSettings"];
  readonly detached: boolean;
}) {
  const { turn, deps } = args;
  const signals = [
    deps.turnControl?.signal,
    deps.turnControl?.executionSignal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  return commitExecution({
    store: deps.store,
    signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
    sessionId: turn.sessionId,
    executionContext: turn.executionContext,
    runtimes: args.manifests,
    results: [...turn.runtimeResults, ...(turn.nestedRuntimeResults ?? [])],
    journalMessages: collectExecutionJournal(turn),
    suspensions: collectExecutionSuspensions(turn),
    turnIds: [turn.turnId],
    completion: args.detached
      ? { kind: "detached", turnId: turn.turnId }
      : { kind: "turn", turnId: turn.turnId, durationMs: turn.durationMs },
    hookPipeline: deps.hookPipeline,
    hookSettings: buildHookSettings(args.manifests, args.userSettings),
    eventBus: deps.eventBus,
    emitter: deps.emitter,
    ...(turn.setupRan ? { setupRan: turn.setupRan } : {}),
    ...(deps.mediaStore ? { mediaStore: deps.mediaStore } : {}),
    loadOutputSchema: async (runtimeId) => {
      const runtime = args.manifests.find((item) => item.name === runtimeId);
      return runtime
        ? (await deps.loadRuntime(runtime, args.locale, turn.sessionId))
            ?.outputSchema
        : undefined;
    },
  });
}

export async function runDeferredFollower(args: {
  readonly follower: DeferredFollowerInput;
  readonly sessionId: string;
  readonly locale: string;
  readonly manifests: readonly RuntimeManifest[];
  readonly deps: TurnExecutorDeps & { readonly store: DataStore };
  readonly userSettings?: Record<string, unknown>;
}): Promise<DeferredFollowerJobResult> {
  const { store } = args.deps;
  const manifest = args.manifests.find(
    (item) => item.name === args.follower.runtimeId,
  );
  if (!manifest)
    throw new Error(`deferred follower not found: ${args.follower.runtimeId}`);
  const loaded = await args.deps.loadRuntime(
    manifest,
    args.locale,
    args.sessionId,
  );
  if (!loaded?.handler)
    throw new Error(
      `deferred follower has no handler: ${args.follower.runtimeId}`,
    );

  const jobId = makeJobId();
  const turnId = `turn-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  await store.setPluginData({
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
  const userSettings = snapshotUserSettings(
    args.userSettings ? { [manifest.pluginId]: args.userSettings } : undefined,
  );
  let runtimeResult: RuntimeResult;
  let runtimeResults: readonly RuntimeResult[];
  let deferredFollowers: readonly DeferredFollowerInput[] = [];
  try {
    // Match the host's detached event invocation. The shared executor owns
    // setting defaults, buffered writes, timeouts and capability revocation.
    const turn = await executeTurn(
      {
        sessionId: args.sessionId,
        turnId,
        playerMessage: "",
        locale: args.locale,
        origin: "background",
        manualTrigger: {
          runtimeId: manifest.name,
          triggerEvent: args.follower.triggerEvent,
        },
        userSettings,
      },
      args.manifests,
      args.deps,
    );
    const target = turn.runtimeResults.find(
      (result) => result.runtimeId === manifest.name,
    );
    if (!target)
      throw new Error(`deferred follower produced no result: ${manifest.name}`);
    runtimeResults = [
      ...turn.runtimeResults,
      ...(turn.nestedRuntimeResults ?? []),
    ];
    // One isolated in-memory run owns this store. As in the host, all sibling
    // and nested proposals share a single commit; no per-result commit loop.
    const commit = await commitDebugExecution({
      turn,
      manifests: args.manifests,
      deps: args.deps,
      locale: args.locale,
      userSettings,
      detached: true,
    });
    // The host only chains events after their producing execution commits.
    if (commit.status === "committed")
      deferredFollowers = turn.deferredFollowers ?? [];
    runtimeResult =
      commit.status === "committed"
        ? target
        : {
            ...target,
            status: "failed",
            error:
              commit.error ??
              commit.failedProposals[0]?.error ??
              "Execution commit failed",
          };
    runtimeResults = runtimeResults.map((result) =>
      result === target ? runtimeResult : result,
    );
  } catch (error) {
    runtimeResult = {
      runtimeId: args.follower.runtimeId,
      pluginId: args.follower.pluginId,
      runId: crypto.randomUUID(),
      turnId,
      status: "failed",
      durationMs: Date.now() - startMs,
      output: {},
      toolCalls: [],
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    runtimeResults = [runtimeResult];
  }

  const failed =
    runtimeResult.status === "failed" || runtimeResult.status === "skipped";
  const status = failed ? "failed" : "done";
  const completedAt = new Date().toISOString();
  await store.setPluginData({
    id: `${args.sessionId}:${args.follower.pluginId}:_jobs:${jobId}`,
    sessionId: args.sessionId,
    pluginId: args.follower.pluginId,
    namespace: "_jobs",
    key: jobId,
    value: {
      status,
      runtimeId: args.follower.runtimeId,
      turnId,
      startedAt,
      completedAt,
      durationMs: runtimeResult.durationMs,
      ...(runtimeResult.error ? { error: runtimeResult.error } : {}),
      runtimeResults,
    },
    createdAt: startedAt,
    updatedAt: completedAt,
  });
  return {
    jobId,
    runtimeId: args.follower.runtimeId,
    pluginId: args.follower.pluginId,
    status,
    result: runtimeResult,
    runtimeResults,
    deferredFollowers,
  };
}
