import type { DataStore } from "@covel/store";
import type { RuntimeResult, TurnResult } from "@covel/shared";
import {
  deriveBackgroundJobCompletion,
  deriveFollowerRuntimeJobResult,
  type ManualTurnSummary,
} from "./runtime-response.js";
import {
  makePendingPluginJobValue,
  makeTerminalPluginJobValue,
  type PluginJobTriggerEvent,
  writePluginJob,
} from "./jobs.js";

export interface ScheduledPluginJob {
  readonly jobId: string;
  readonly runtimeId: string;
}

export interface DeferredFollower {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly triggerEvent: PluginJobTriggerEvent;
}

interface PluginRpcJobRunnerOptions {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly runManualTurn: () => Promise<ManualTurnSummary>;
  readonly runDeferredFollowerTurn: (args: {
    readonly followerTurnId: string;
    readonly runtimeId: string;
    readonly triggerEvent: PluginJobTriggerEvent;
    readonly userSettings?: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
  }) => Promise<{ readonly turnResult: TurnResult }>;
  readonly hasActiveRuntime: (runtimeId: string) => boolean;
}

// ── Bounded background fan-out ──────────────────────────────────────
//
// The setImmediate fan-out used to be unbounded: a burst of RPC calls (or a
// follower cascade) could start arbitrarily many manual turns at once. Cap
// concurrent background jobs per process; overflow starts FIFO as slots free.
// Safe with follower chains: a parent only *enqueues* its followers (it never
// awaits their execution), so holding a slot cannot deadlock the queue.
// ponytail: process-global cap; make it per-session if one session's burst
// starving others ever matters.
const MAX_CONCURRENT_BACKGROUND_JOBS = 4;
let runningBackgroundJobs = 0;
const backgroundJobQueue: Array<() => void> = [];

function scheduleBackgroundJob(task: () => Promise<void>): void {
  const start = (): void => {
    runningBackgroundJobs++;
    void task().finally(() => {
      runningBackgroundJobs--;
      backgroundJobQueue.shift()?.();
    });
  };
  if (runningBackgroundJobs < MAX_CONCURRENT_BACKGROUND_JOBS) {
    setImmediate(start);
  } else {
    backgroundJobQueue.push(start);
  }
}

export interface PluginRpcJobRunner {
  enqueueBackgroundRuntime(args: {
    readonly pluginId: string;
    readonly runtimeId: string;
    readonly turnId: string;
    readonly payload?: unknown;
  }): Promise<ScheduledPluginJob>;
  enqueueExpectedFollowerRuntime(args: {
    readonly pluginId: string;
    readonly runtimeId: string;
    readonly turnId: string;
  }): Promise<ScheduledPluginJob & { readonly phase: "prompt" }>;
  scheduleDeferredFollowers(
    followers: readonly DeferredFollower[],
  ): Promise<readonly ScheduledPluginJob[]>;
}

export function createPluginRpcJobRunner(
  options: PluginRpcJobRunnerOptions,
): PluginRpcJobRunner {
  const persistJob = async (args: {
    readonly pluginId: string;
    readonly jobId: string;
    readonly startedAt: string;
    readonly updatedAt?: string;
    readonly value: Parameters<typeof writePluginJob>[1]["value"];
  }): Promise<void> => {
    await writePluginJob(options.store, {
      sessionId: options.sessionId,
      pluginId: args.pluginId,
      jobId: args.jobId,
      startedAt: args.startedAt,
      updatedAt: args.updatedAt ?? args.startedAt,
      value: args.value,
    });
  };

  const runDeferredFollower = async (args: {
    readonly jobId: string;
    readonly runtimeId: string;
    readonly pluginId: string;
    readonly triggerEvent: PluginJobTriggerEvent;
    readonly followerTurnId: string;
    readonly startedAt: string;
  }): Promise<void> => {
    if (!options.hasActiveRuntime(args.runtimeId)) {
      const completedAt = new Date().toISOString();
      await persistJob({
        pluginId: args.pluginId,
        jobId: args.jobId,
        startedAt: args.startedAt,
        updatedAt: completedAt,
        value: makeTerminalPluginJobValue({
          status: "failed",
          runtimeId: args.runtimeId,
          turnId: args.followerTurnId,
          triggerEvent: args.triggerEvent,
          startedAt: args.startedAt,
          completedAt,
          error: "follower manifest not found in active set",
        }),
      });
      return;
    }

    try {
      const { turnResult } = await options.runDeferredFollowerTurn({
        followerTurnId: args.followerTurnId,
        runtimeId: args.runtimeId,
        triggerEvent: args.triggerEvent,
        ...(options.userSettings ? { userSettings: options.userSettings } : {}),
      });

      const followerResult = turnResult.runtimeResults.find(
        (result) => result.runtimeId === args.runtimeId,
      );
      if (turnResult.deferredFollowers?.length) {
        await scheduleDeferredFollowers(turnResult.deferredFollowers);
      }

      const jobResult = deriveFollowerRuntimeJobResult({
        followerResult,
        turnDurationMs: turnResult.durationMs,
      });
      const completedAt = new Date().toISOString();
      await persistJob({
        pluginId: args.pluginId,
        jobId: args.jobId,
        startedAt: args.startedAt,
        updatedAt: completedAt,
        value: makeTerminalPluginJobValue({
          status: jobResult.jobStatus,
          runtimeId: args.runtimeId,
          turnId: args.followerTurnId,
          triggerEvent: args.triggerEvent,
          startedAt: args.startedAt,
          completedAt,
          durationMs: jobResult.durationMs,
          ...(jobResult.error ? { error: jobResult.error } : {}),
          runtimeResults: [
            {
              runtimeId: args.runtimeId,
              pluginId: args.pluginId,
              status: jobResult.runtimeStatus,
              durationMs: jobResult.durationMs,
              ...(jobResult.error ? { error: jobResult.error } : {}),
              output: jobResult.output,
            },
          ],
        }),
      });
    } catch (err) {
      const completedAt = new Date().toISOString();
      await persistJob({
        pluginId: args.pluginId,
        jobId: args.jobId,
        startedAt: args.startedAt,
        updatedAt: completedAt,
        value: makeTerminalPluginJobValue({
          status: "failed",
          runtimeId: args.runtimeId,
          turnId: args.followerTurnId,
          triggerEvent: args.triggerEvent,
          startedAt: args.startedAt,
          completedAt,
          error: err instanceof Error ? err.message : String(err),
        }),
      }).catch(() => undefined);
    }
  };

  const scheduleDeferredFollowers = async (
    followers: readonly DeferredFollower[],
  ): Promise<readonly ScheduledPluginJob[]> => {
    const scheduled: ScheduledPluginJob[] = [];
    for (const follower of followers) {
      const jobId = crypto.randomUUID();
      const followerTurnId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      await persistJob({
        pluginId: follower.pluginId,
        jobId,
        startedAt,
        value: makePendingPluginJobValue({
          runtimeId: follower.runtimeId,
          turnId: followerTurnId,
          triggerEvent: follower.triggerEvent,
          startedAt,
        }),
      });
      scheduled.push({ jobId, runtimeId: follower.runtimeId });
      scheduleBackgroundJob(() =>
        runDeferredFollower({
          jobId,
          runtimeId: follower.runtimeId,
          pluginId: follower.pluginId,
          triggerEvent: follower.triggerEvent,
          followerTurnId,
          startedAt,
        }),
      );
    }
    return scheduled;
  };

  const enqueueBackgroundRuntime = async (args: {
    readonly pluginId: string;
    readonly runtimeId: string;
    readonly turnId: string;
    readonly payload?: unknown;
  }): Promise<ScheduledPluginJob> => {
    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await persistJob({
      pluginId: args.pluginId,
      jobId,
      startedAt,
      value: makePendingPluginJobValue({
        runtimeId: args.runtimeId,
        turnId: args.turnId,
        payload: args.payload,
        startedAt,
      }),
    });

    scheduleBackgroundJob(async (): Promise<void> => {
      try {
        const summary = await options.runManualTurn();
        const completion = deriveBackgroundJobCompletion(summary);
        const completedAt = new Date().toISOString();
        await persistJob({
          pluginId: args.pluginId,
          jobId,
          startedAt,
          updatedAt: completedAt,
          value: makeTerminalPluginJobValue({
            status: completion.status,
            runtimeId: args.runtimeId,
            turnId: summary.turnId,
            payload: args.payload,
            startedAt,
            completedAt,
            durationMs: summary.durationMs,
            runtimeResults: summary.runtimeResults,
            ...(completion.error ? { error: completion.error } : {}),
            ...(summary.abortReason
              ? { abortReason: summary.abortReason }
              : {}),
          }),
        });
      } catch (err) {
        const completedAt = new Date().toISOString();
        await persistJob({
          pluginId: args.pluginId,
          jobId,
          startedAt,
          updatedAt: completedAt,
          value: makeTerminalPluginJobValue({
            status: "failed",
            runtimeId: args.runtimeId,
            turnId: args.turnId,
            payload: args.payload,
            startedAt,
            completedAt,
            error:
              err instanceof Error ? err.message : "runtime execution failed",
          }),
        }).catch(() => undefined);
      }
    });

    return { jobId, runtimeId: args.runtimeId };
  };

  const enqueueExpectedFollowerRuntime = async (args: {
    readonly pluginId: string;
    readonly runtimeId: string;
    readonly turnId: string;
  }): Promise<ScheduledPluginJob & { readonly phase: "prompt" }> => {
    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await persistJob({
      pluginId: args.pluginId,
      jobId,
      startedAt,
      value: makePendingPluginJobValue({
        progress: 1,
        runtimeId: args.runtimeId,
        turnId: args.turnId,
        startedAt,
        phase: "prompt",
        messageKey: "pluginRpc.jobs.imagePromptGenerating",
        message: "Generating image prompt...",
      }),
    });

    scheduleBackgroundJob(async (): Promise<void> => {
      try {
        const summary = await options.runManualTurn();
        const deferredJobs = summary.deferredFollowers.length
          ? await scheduleDeferredFollowers(summary.deferredFollowers)
          : [];
        const completedAt = new Date().toISOString();
        const failedResult = summary.runtimeResults.find(
          (result) => result.status === "failed",
        );

        if (deferredJobs.length > 0) {
          await persistJob({
            pluginId: args.pluginId,
            jobId,
            startedAt,
            updatedAt: completedAt,
            value: makeTerminalPluginJobValue({
              status: "done",
              runtimeId: args.runtimeId,
              turnId: summary.turnId,
              startedAt,
              completedAt,
              durationMs: summary.durationMs,
              phase: "prompt",
              messageKey: "pluginRpc.jobs.imagePromptQueued",
              message: "Image prompt generated; image job queued.",
              runtimeResults: summary.runtimeResults,
              deferredJobs,
              ...(summary.abortReason
                ? { abortReason: summary.abortReason }
                : {}),
            }),
          });
          return;
        }

        await persistJob({
          pluginId: args.pluginId,
          jobId,
          startedAt,
          updatedAt: completedAt,
          value: makeTerminalPluginJobValue({
            status: "failed",
            runtimeId: args.runtimeId,
            turnId: summary.turnId,
            startedAt,
            completedAt,
            durationMs: summary.durationMs,
            error:
              failedResult?.error ??
              `runtime "${args.runtimeId}" completed without emitting a matching background follower event`,
            runtimeResults: summary.runtimeResults,
            reason: "expected-background-follower-missing",
            ...(summary.abortReason
              ? { abortReason: summary.abortReason }
              : {}),
          }),
        });
      } catch (err) {
        const completedAt = new Date().toISOString();
        await persistJob({
          pluginId: args.pluginId,
          jobId,
          startedAt,
          updatedAt: completedAt,
          value: makeTerminalPluginJobValue({
            status: "failed",
            runtimeId: args.runtimeId,
            turnId: args.turnId,
            startedAt,
            completedAt,
            error:
              err instanceof Error ? err.message : "runtime execution failed",
          }),
        }).catch(() => undefined);
      }
    });

    return { jobId, runtimeId: args.runtimeId, phase: "prompt" };
  };

  return {
    enqueueBackgroundRuntime,
    enqueueExpectedFollowerRuntime,
    scheduleDeferredFollowers,
  };
}
