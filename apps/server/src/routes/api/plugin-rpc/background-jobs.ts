import type { PluginBackgroundQueue } from "./background-queue.js";
import type { DataStore } from "@covel/store";
import type { TurnResult } from "@covel/shared";
import type { SessionLock } from "../../../lib/session-lock.js";
import { sessionApprovalScope } from "../session/session-guard.js";
import {
  SessionApprovalScopeChangedError,
  SessionNotActiveError,
} from "./runtime-turn.js";
import {
  commitFailureMessage,
  deriveBackgroundJobCompletion,
  deriveFollowerRuntimeJobResult,
  type ManualTurnSummary,
  type TurnCommitOutcome,
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
  readonly queue: PluginBackgroundQueue;
  readonly store: DataStore;
  readonly sessionId: string;
  readonly sessionLock: SessionLock;
  readonly approvalScopes: ReadonlyMap<string, string>;
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly runManualTurn: (signal: AbortSignal) => Promise<ManualTurnSummary>;
  readonly runDeferredFollowerTurn: (args: {
    readonly followerTurnId: string;
    readonly runtimeId: string;
    readonly executionSignal: AbortSignal;
    readonly triggerEvent: PluginJobTriggerEvent;
    readonly userSettings?: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
  }) => Promise<{
    readonly turnResult: TurnResult;
    readonly commit: TurnCommitOutcome;
  }>;
  readonly hasActiveRuntime: (runtimeId: string) => boolean;
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
    readonly terminal?: boolean;
    readonly value: Parameters<typeof writePluginJob>[1]["value"];
  }): Promise<void> => {
    await options.sessionLock.withLock(options.sessionId, async () => {
      const session = await options.store.getSession(options.sessionId);
      const expected = options.approvalScopes.get(args.pluginId);
      if (!session) throw new SessionNotActiveError("deleted");
      if (
        session.status !== "active" &&
        !(args.terminal && session.status === "paused")
      ) {
        throw new SessionNotActiveError(session.status);
      }
      if (
        !expected ||
        sessionApprovalScope(session, args.pluginId) !== expected
      ) {
        throw new SessionApprovalScopeChangedError();
      }
      await writePluginJob(options.store, {
        sessionId: options.sessionId,
        pluginId: args.pluginId,
        jobId: args.jobId,
        startedAt: args.startedAt,
        updatedAt: args.updatedAt ?? args.startedAt,
        value: args.value,
      });
    });
  };

  const scheduleJob = async (
    args: Parameters<typeof makePendingPluginJobValue>[0] & {
      readonly pluginId: string;
      readonly jobId: string;
    },
    run: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    await options.queue.schedule({
      sessionId: options.sessionId,
      jobId: args.jobId,
      prepare: () =>
        persistJob({
          pluginId: args.pluginId,
          jobId: args.jobId,
          startedAt: args.startedAt,
          value: makePendingPluginJobValue(args),
        }),
      run,
      reject: async (reason) => {
        const completedAt = new Date().toISOString();
        await persistJob({
          pluginId: args.pluginId,
          jobId: args.jobId,
          startedAt: args.startedAt,
          updatedAt: completedAt,
          terminal: true,
          value: makeTerminalPluginJobValue({
            ...args,
            status: "failed",
            progress: 100,
            message: undefined,
            messageKey: undefined,
            completedAt,
            reason,
            error:
              reason === "server-shutdown"
                ? "server shut down before job execution"
                : "background job queue is full",
          }),
        });
      },
    });
  };

  const runDeferredFollower = async (args: {
    readonly jobId: string;
    readonly runtimeId: string;
    readonly pluginId: string;
    readonly triggerEvent: PluginJobTriggerEvent;
    readonly followerTurnId: string;
    readonly startedAt: string;
    readonly executionSignal: AbortSignal;
  }): Promise<void> => {
    if (!options.hasActiveRuntime(args.runtimeId)) {
      const completedAt = new Date().toISOString();
      await persistJob({
        pluginId: args.pluginId,
        jobId: args.jobId,
        startedAt: args.startedAt,
        updatedAt: completedAt,
        terminal: true,
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
      const { turnResult, commit } = await options.runDeferredFollowerTurn({
        followerTurnId: args.followerTurnId,
        runtimeId: args.runtimeId,
        executionSignal: args.executionSignal,
        triggerEvent: args.triggerEvent,
        ...(options.userSettings ? { userSettings: options.userSettings } : {}),
      });

      const followerResult = turnResult.runtimeResults.find(
        (result) => result.runtimeId === args.runtimeId,
      );
      // Only chain further followers off a turn whose writes actually landed —
      // otherwise the chain builds on state that rolled back.
      if (commit.committed && turnResult.deferredFollowers?.length) {
        await scheduleDeferredFollowers(turnResult.deferredFollowers);
      }

      const jobResult = deriveFollowerRuntimeJobResult({
        followerResult,
        turnDurationMs: turnResult.durationMs,
        commit,
      });
      const completedAt = new Date().toISOString();
      await persistJob({
        pluginId: args.pluginId,
        jobId: args.jobId,
        startedAt: args.startedAt,
        updatedAt: completedAt,
        terminal: true,
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
        terminal: true,
        value: makeTerminalPluginJobValue({
          status: "failed",
          runtimeId: args.runtimeId,
          turnId: args.followerTurnId,
          triggerEvent: args.triggerEvent,
          startedAt: args.startedAt,
          completedAt,
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const scheduleDeferredFollowers = async (
    followers: readonly DeferredFollower[],
  ): Promise<readonly ScheduledPluginJob[]> => {
    const scheduled: ScheduledPluginJob[] = [];
    for (const follower of followers) {
      if (options.queue.signal.aborted) break;
      const jobId = crypto.randomUUID();
      const followerTurnId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      await scheduleJob(
        {
          pluginId: follower.pluginId,
          jobId,
          startedAt,
          runtimeId: follower.runtimeId,
          turnId: followerTurnId,
          triggerEvent: follower.triggerEvent,
        },
        (executionSignal) =>
          runDeferredFollower({
            jobId,
            runtimeId: follower.runtimeId,
            pluginId: follower.pluginId,
            triggerEvent: follower.triggerEvent,
            followerTurnId,
            startedAt,
            executionSignal,
          }),
      );
      scheduled.push({ jobId, runtimeId: follower.runtimeId });
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
    await scheduleJob(
      {
        pluginId: args.pluginId,
        jobId,
        startedAt,
        runtimeId: args.runtimeId,
        turnId: args.turnId,
        ...(args.payload !== undefined ? { payload: args.payload } : {}),
      },
      async (executionSignal): Promise<void> => {
        try {
          const summary = await options.runManualTurn(executionSignal);
          const completion = deriveBackgroundJobCompletion(summary);
          // A background entry runtime may itself emit events for additional
          // `execution: background` followers (for example, image prompt
          // generation followed by the provider render). Preserve that chain
          // exactly as the synchronous entry path does. Followers are only
          // published after the entry turn committed, so no child observes
          // rolled-back prompt/state output.
          const deferredJobs =
            completion.status === "done" &&
            summary.commit.committed &&
            summary.deferredFollowers.length > 0
              ? await scheduleDeferredFollowers(summary.deferredFollowers)
              : [];
          const completedAt = new Date().toISOString();
          await persistJob({
            pluginId: args.pluginId,
            jobId,
            startedAt,
            updatedAt: completedAt,
            terminal: true,
            value: makeTerminalPluginJobValue({
              status: completion.status,
              runtimeId: args.runtimeId,
              turnId: summary.turnId,
              payload: args.payload,
              startedAt,
              completedAt,
              durationMs: summary.durationMs,
              runtimeResults: summary.runtimeResults,
              ...(deferredJobs.length > 0 ? { deferredJobs } : {}),
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
            terminal: true,
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
          });
        }
      },
    );
    return { jobId, runtimeId: args.runtimeId };
  };

  const enqueueExpectedFollowerRuntime = async (args: {
    readonly pluginId: string;
    readonly runtimeId: string;
    readonly turnId: string;
  }): Promise<ScheduledPluginJob & { readonly phase: "prompt" }> => {
    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await scheduleJob(
      {
        pluginId: args.pluginId,
        jobId,
        startedAt,
        runtimeId: args.runtimeId,
        turnId: args.turnId,
        progress: 1,
        phase: "prompt",
        messageKey: "pluginRpc.jobs.imagePromptGenerating",
        message: "Generating image prompt...",
      },
      async (executionSignal): Promise<void> => {
        try {
          const summary = await options.runManualTurn(executionSignal);
          // A runtime can report success while its proposals fail to commit.
          // Scheduling the expected follower onto rolled-back state — or marking
          // the parent job done — would build on writes that never landed.
          if (!summary.commit.committed) {
            const completedAt = new Date().toISOString();
            await persistJob({
              pluginId: args.pluginId,
              jobId,
              startedAt,
              updatedAt: completedAt,
              terminal: true,
              value: makeTerminalPluginJobValue({
                status: "failed",
                runtimeId: args.runtimeId,
                turnId: summary.turnId,
                startedAt,
                completedAt,
                durationMs: summary.durationMs,
                error: commitFailureMessage(summary.commit),
                runtimeResults: summary.runtimeResults,
                ...(summary.abortReason
                  ? { abortReason: summary.abortReason }
                  : {}),
              }),
            });
            return;
          }
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
              terminal: true,
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
            terminal: true,
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
            terminal: true,
            value: makeTerminalPluginJobValue({
              status: "failed",
              runtimeId: args.runtimeId,
              turnId: args.turnId,
              startedAt,
              completedAt,
              error:
                err instanceof Error ? err.message : "runtime execution failed",
            }),
          });
        }
      },
    );
    return { jobId, runtimeId: args.runtimeId, phase: "prompt" };
  };

  return {
    enqueueBackgroundRuntime,
    enqueueExpectedFollowerRuntime,
    scheduleDeferredFollowers,
  };
}
