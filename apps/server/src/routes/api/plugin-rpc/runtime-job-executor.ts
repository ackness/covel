import { planTurnDetachment } from "@covel/runtime";
import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { RuntimeManifest, RuntimeResult, TurnResult } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { withRequestLlmOptions } from "../../../request-llm-context.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../session/session-guard.js";
import type { RuntimeJobRecord } from "./jobs.js";
import {
  createJobCredentialHandoff,
  type RuntimeJobCredentials,
  type RuntimeJobServices,
} from "./runtime-job-credentials.js";
import { deferredJobRefs } from "./runtime-job-enqueue.js";
import { queueFollowUpsWith, refuseFollowUps } from "../commit-envelope.js";
import {
  requireActiveSession,
  syncSessionRuntimes,
} from "../execution-context.js";
import { settleActivatedRun } from "./runtime-response.js";
import type {
  RunCommitSteps,
  createPluginRpcRuntimeTurnRunner,
} from "./runtime-turn.js";
import { publishDeferredRuntimeJobs } from "./settled-request.js";
import {
  runtimeJobIncarnation,
  parseActivatedRuntimeJobPayload,
  parseStagedRuntimeJobPayload,
  publishRuntimeJobStatusEvent,
  RuntimeJobNoLongerCurrentError,
  type ActivatedRuntimeJobPayload,
  type RuntimeJobExecutor,
} from "./runtime-job-worker.js";

/** Build the turn runner a claimed job executes with. */
export type RuntimeJobRunnerFactory = (
  job: RuntimeJobRecord,
  services: RuntimeJobServices,
  activeRuntimes: readonly RuntimeManifest[],
  session: {
    readonly locale: string;
    readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
  },
  expectedApprovalScope: string,
) => ReturnType<typeof createPluginRpcRuntimeTurnRunner>;

/**
 * Executor for every durable runtime job: scheduler-detached stages and
 * background manual/event activations. `handoff` marks services handed over
 * by a request, which the jobs this one queues may inherit.
 */
export function createRuntimeJobExecutor(deps: {
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly registry: Pick<
    PluginRegistry,
    "syncSessionActivations" | "getActiveRuntimes"
  >;
  readonly credentials?: Pick<RuntimeJobCredentials, "register" | "discard">;
  readonly createRunner: RuntimeJobRunnerFactory;
}): (
  requestServices: RuntimeJobServices,
  handoff?: boolean,
) => RuntimeJobExecutor {
  const { store, eventBus, registry } = deps;
  const createJobRunner = deps.createRunner;
  /**
   * Re-check what the job was admitted under before spending provider work.
   * This read takes no session lock (a foreground turn may hold it for
   * minutes); the commit re-checks the session under the lock.
   */
  const admitJob = async (
    job: RuntimeJobRecord,
    expected: {
      readonly expectedSessionIncarnation: string;
      readonly expectedApprovalScope: string;
    },
  ): Promise<readonly RuntimeManifest[]> => {
    const live = await requireActiveSession(store, job.sessionId);
    if (
      sessionIncarnationIdentity(live) !==
        expected.expectedSessionIncarnation ||
      sessionApprovalScope(live, job.pluginId) !==
        expected.expectedApprovalScope
    ) {
      throw new RuntimeJobNoLongerCurrentError();
    }
    return syncSessionRuntimes(registry, job.sessionId, live.activePlugins);
  };

  /**
   * Background manual RPC calls and event followers. A failure the runtime
   * reports in its own result still commits its writes; followers it emitted
   * and stage jobs it deferred (a manually run `turnCompletion: detached`
   * target) are queued in the same transaction and inherit its credentials.
   */
  const executeActivatedJob = async (
    job: RuntimeJobRecord,
    control: Parameters<RuntimeJobExecutor>[1],
    payload: ActivatedRuntimeJobPayload,
    requestServices: RuntimeJobServices,
    handoff: boolean,
  ): Promise<void> => {
    const activeRuntimes = await admitJob(job, payload);
    const target = activeRuntimes.find(
      (runtime) => runtime.name === job.runtimeId,
    );
    if (!target || target.pluginId !== job.pluginId) {
      throw new RuntimeJobNoLongerCurrentError();
    }
    const runner = createJobRunner(
      job,
      requestServices,
      activeRuntimes,
      payload,
      payload.expectedApprovalScope,
    );
    // Services a request handed over pass on to the jobs this run queues.
    const credentials = createJobCredentialHandoff(
      handoff ? deps.credentials : undefined,
      () => requestServices,
    );
    const settle = (turnResult: TurnResult) =>
      settleActivatedRun({
        activation: payload.activation,
        runtimeId: job.runtimeId,
        turnResult,
        ...(payload.expectFollower ? { expectFollower: true } : {}),
      });
    const commitSteps: RunCommitSteps = {
      // Followers chain only off a run that did not fail.
      followUps: queueFollowUpsWith(
        {
          sessionId: job.sessionId,
          activeRuntimes,
          locale: payload.locale,
          ...(payload.userSettings
            ? { userSettings: payload.userSettings }
            : {}),
          credentials,
          sourceRuntimeId: job.runtimeId,
        },
        (turnResult) => settle(turnResult).followers,
      ),
      completeInTx: async (tx, turnResult, _isolation, queued) => {
        const settlement = settle(turnResult);
        const deferredJobs = deferredJobRefs([
          ...queued.runtimeJobs,
          ...queued.followerJobs,
        ]);
        const result = {
          turnId: turnResult.turnId,
          executionId: turnResult.executionContext.executionId,
          runtimeId: job.runtimeId,
          durationMs: turnResult.durationMs,
          runtimeResults: settlement.runtimeResults,
          ...(deferredJobs.length > 0 ? { deferredJobs } : {}),
        };
        if (settlement.failure)
          await control.failInTx(tx, { ...settlement.failure, result });
        else await control.completeInTx(tx, result);
      },
    };
    const queuedRun = {
      executionSignal: control.signal,
      expectedSessionIncarnation: payload.expectedSessionIncarnation,
      // The job commits only under the plugin version it started with.
      ...(target.version !== undefined
        ? { expectedPluginVersion: target.version }
        : {}),
      beforeExecute: control.assertCurrent,
      executionFinished: control.executionFinished,
      beforeCommit: control.beforeCommit,
      ...commitSteps,
      ...(payload.userSettings ? { userSettings: payload.userSettings } : {}),
    };
    const retrySeedResults = payload.retryFromTurnId
      ? ((
          await store.queryTurnResults(job.sessionId, {
            turnId: payload.retryFromTurnId,
            limit: 1,
          })
        )[0]?.runtimeResults as readonly RuntimeResult[] | undefined)
      : undefined;
    const run = () =>
      payload.activation === "manual"
        ? runner.runManualTurn({
            ...queuedRun,
            turnId: payload.turnId,
            runtimeId: job.runtimeId,
            detached: true,
            ...(payload.input !== undefined ? { payload: payload.input } : {}),
            ...(retrySeedResults
              ? {
                  retrySeedResults,
                  sourceTurnId: payload.retryFromTurnId,
                }
              : {}),
          })
        : runner.runDeferredFollowerTurn({
            ...queuedRun,
            followerTurnId: payload.turnId,
            runtimeId: job.runtimeId,
            triggerEvent: payload.triggerEvent!,
          });
    let commit;
    try {
      commit = (await run()).commit;
    } catch (error) {
      credentials.discard();
      throw error;
    }
    if (!commit.committed) {
      credentials.discard();
      throw new Error(commit.error ?? "runtime job proposals did not commit");
    }
    const { followUps } = commit;
    credentials.handOff(followUps.followerJobs);
    for (const follower of followUps.followerJobs)
      publishRuntimeJobStatusEvent(
        eventBus,
        follower.status,
        runtimeJobIncarnation(follower.job.payload) ?? "",
      );
    await publishDeferredRuntimeJobs(
      { eventBus, worker: undefined },
      followUps.runtimeJobs,
    );
  };

  const executeRuntimeJob =
    (
      requestServices: RuntimeJobServices,
      handoff = false,
    ): RuntimeJobExecutor =>
    async (job, control) => {
      const activated = parseActivatedRuntimeJobPayload(job.payload);
      if (activated)
        return executeActivatedJob(
          job,
          control,
          activated,
          requestServices,
          handoff,
        );
      const payload = parseStagedRuntimeJobPayload(job.payload);
      if (
        !payload ||
        payload.descriptor.jobId !== job.jobId ||
        payload.descriptor.pluginId !== job.pluginId ||
        payload.descriptor.runtimeId !== job.runtimeId
      ) {
        throw new Error("invalid detached runtime job payload");
      }
      const activeRuntimes = await admitJob(job, payload);
      const target = activeRuntimes.find(
        (runtime) => runtime.name === job.runtimeId,
      );
      if (
        !target ||
        target.pluginId !== job.pluginId ||
        target.version !== payload.descriptor.pluginVersion ||
        (target.presentation !== undefined) !==
          (payload.descriptor.presentation !== undefined) ||
        (target.presentation && !payload.descriptor.presentation?.committed) ||
        !planTurnDetachment(activeRuntimes).eligibleRuntimeIds.has(
          job.runtimeId,
        )
      ) {
        throw new RuntimeJobNoLongerCurrentError();
      }

      const runner = createJobRunner(
        job,
        requestServices,
        activeRuntimes,
        payload,
        payload.expectedApprovalScope,
      );
      const backgroundTurnId = crypto.randomUUID();
      const outcome = await runner.runDetachedStage({
        descriptor: payload.descriptor,
        backgroundTurnId,
        expectedSessionIncarnation: payload.expectedSessionIncarnation,
        ...(payload.userSettings ? { userSettings: payload.userSettings } : {}),
        ...(payload.modelOverride
          ? { modelOverride: payload.modelOverride }
          : {}),
        ...(payload.runtimeModelOverrides
          ? { runtimeModelOverrides: payload.runtimeModelOverrides }
          : {}),
        // A detached stage derives no follow-up work: it detaches nothing
        // further, and its commit refuses the events followers chain from.
        followUps: refuseFollowUps,
        completeInTx: async (tx, turnResult) => {
          const runtimeResult = turnResult.runtimeResults.find(
            (result) => result.runtimeId === job.runtimeId,
          );
          if (
            runtimeResult?.status !== "success" &&
            !(target.presentation && runtimeResult?.status === "skipped")
          ) {
            throw new Error(
              runtimeResult?.error ??
                `detached runtime ended with ${runtimeResult?.status ?? "no result"}`,
            );
          }
          const runtimeOutput = runtimeResult.output;
          if (
            !target.presentation &&
            (runtimeOutput?.status === "failed" ||
              (typeof runtimeOutput?.error === "string" && runtimeOutput.error))
          ) {
            throw new Error(
              typeof runtimeOutput.error === "string"
                ? runtimeOutput.error
                : "detached runtime reported a failed business result",
            );
          }
          await control.completeInTx(tx, {
            turnId: turnResult.turnId,
            executionId: turnResult.executionContext.executionId,
            runtimeId: runtimeResult.runtimeId,
            durationMs: runtimeResult.durationMs,
            output: runtimeResult.output,
          });
        },
        beforeCommit: control.beforeCommit,
        beforeExecute: control.assertCurrent,
        executionFinished: control.executionFinished,
        executionSignal: control.signal,
      });
      if (!outcome.commit.committed) {
        throw new Error(
          outcome.commit.error ?? "detached runtime proposals did not commit",
        );
      }
    };

  // Restore the queuing request's LLM context, as request-scoped work sees it.
  return (requestServices, handoff) => {
    const execute = executeRuntimeJob(requestServices, handoff);
    return (job, control) =>
      withRequestLlmOptions(requestServices.llmOptions, () =>
        execute(job, control),
      );
  };
}
