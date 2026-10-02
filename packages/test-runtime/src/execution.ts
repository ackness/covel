import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  commitExecution,
  executeTurn,
  snapshotUserSettings,
  type TurnExecutorDeps,
  type ExecutedTurn,
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

/**
 * Record a background job the way the host's runtime job worker does, as a
 * `_runtime_jobs` row, so panels and reports read the same shape.
 */
async function writeHarnessJob(
  store: DataStore,
  args: {
    readonly sessionId: string;
    readonly pluginId: string;
    readonly runtimeId: string;
    readonly jobId: string;
    readonly activation: "manual" | "event";
    readonly sourceTurnId: string;
    readonly status: "running" | "succeeded" | "failed";
    readonly enqueuedAt: string;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly error?: string;
    readonly reason?: "runtime-reported-failure" | "follower-not-emitted";
  },
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const terminal = args.status !== "running";
  await store.setPluginData({
    id: `${args.sessionId}:${args.pluginId}:_runtime_jobs:${args.jobId}`,
    sessionId: args.sessionId,
    pluginId: args.pluginId,
    namespace: "_runtime_jobs",
    key: args.jobId,
    value: {
      schemaVersion: 1,
      jobId: args.jobId,
      pluginId: args.pluginId,
      runtimeId: args.runtimeId,
      status: args.status,
      origin: { activation: args.activation, sourceTurnId: args.sourceTurnId },
      payload: {},
      enqueuedAt: args.enqueuedAt,
      updatedAt,
      attempt: 1,
      sequence: 1,
      ...(terminal ? { finishedAt: updatedAt } : {}),
      ...(args.result ? { result: args.result } : {}),
      ...(args.error ? { error: args.error } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    },
    createdAt: args.enqueuedAt,
    updatedAt,
  });
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
  const failed = args.runtimeResults.find((item) => item.status === "failed");
  await writeHarnessJob(args.store, {
    sessionId: args.sessionId,
    pluginId: args.pluginId,
    runtimeId: args.runtimeId,
    jobId,
    activation: "manual",
    sourceTurnId: args.turnId,
    status: "failed",
    enqueuedAt: new Date().toISOString(),
    result: { turnId: args.turnId, runtimeResults: args.runtimeResults },
    reason: failed ? "runtime-reported-failure" : "follower-not-emitted",
    error:
      failed?.error ??
      `runtime "${args.runtimeId}" completed without emitting a matching background follower event`,
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
  readonly execution: ExecutedTurn;
  readonly deps: TurnExecutorDeps & { readonly store: DataStore };
  readonly detached: boolean;
}) {
  const { execution, deps } = args;
  const turn = execution.result;
  const signals = [
    deps.turnControl?.signal,
    deps.turnControl?.executionSignal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  return commitExecution({
    store: deps.store,
    signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
    execution,
    completion: args.detached
      ? { kind: "detached", turnId: turn.turnId }
      : { kind: "turn", turnId: turn.turnId, durationMs: turn.durationMs },
    hookPipeline: deps.hookPipeline,
    eventBus: deps.eventBus,
    emitter: deps.emitter,
    ...(deps.mediaStore ? { mediaStore: deps.mediaStore } : {}),
  });
}

export async function runDeferredFollower(args: {
  readonly follower: DeferredFollowerInput;
  readonly sessionId: string;
  readonly locale: string;
  readonly manifests: readonly RuntimeManifest[];
  readonly deps: TurnExecutorDeps & { readonly store: DataStore };
  readonly userSettings?: TurnInput["userSettings"];
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
  const job = {
    sessionId: args.sessionId,
    pluginId: args.follower.pluginId,
    runtimeId: args.follower.runtimeId,
    jobId,
    activation: "event",
    sourceTurnId: turnId,
    enqueuedAt: startedAt,
  } as const;
  await writeHarnessJob(store, { ...job, status: "running" });

  const startMs = Date.now();
  const userSettings = snapshotUserSettings(args.userSettings);
  let runtimeResult: RuntimeResult;
  let runtimeResults: readonly RuntimeResult[];
  let deferredFollowers: readonly DeferredFollowerInput[] = [];
  try {
    // Match the host's detached event invocation. The shared executor owns
    // setting defaults, buffered writes, timeouts and capability revocation.
    const execution = await executeTurn(
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
    const turn = execution.result;
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
      execution,
      deps: args.deps,
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

  const output = (runtimeResult.output ?? {}) as Record<string, unknown>;
  // A handler's explicit skip is complete work. Framework gates do not carry
  // this outcome and must retain their failure signal (e.g. missing upstreams).
  const failed =
    runtimeResult.status === "failed" ||
    Boolean(runtimeResult.error) ||
    (runtimeResult.status === "skipped" && output.outcome !== "skipped") ||
    output.status === "failed" ||
    (typeof output.error === "string" && output.error.length > 0);
  const status = failed ? "failed" : "done";
  await writeHarnessJob(store, {
    ...job,
    status: failed ? "failed" : "succeeded",
    result: { turnId, durationMs: runtimeResult.durationMs, runtimeResults },
    ...(failed
      ? {
          reason: "runtime-reported-failure",
          error: runtimeResult.error ?? "runtime reported failure",
        }
      : {}),
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
