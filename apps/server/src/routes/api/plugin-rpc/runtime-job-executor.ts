import { planTurnDetachment } from "@covel/runtime";
import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { RuntimeManifest, RuntimeResult, TurnResult } from "@covel/shared";
import type { DataStore, StoreTransaction } from "@covel/store";
import { topLevelTurnResults } from "../actions/turn-history.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../session/session-guard.js";
import type { RuntimeJobRecord } from "./jobs.js";
import type {
  RuntimeJobServices,
  createRuntimeJobCredentials,
} from "./runtime-job-credentials.js";
import {
  enqueueEventFollowers,
  type QueuedActivatedRuntimeJob,
} from "./runtime-job-enqueue.js";
import { settleActivatedRun } from "./runtime-response.js";
import type { createPluginRpcRuntimeTurnRunner } from "./runtime-turn.js";
import {
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
  readonly credentials?: Pick<
    ReturnType<typeof createRuntimeJobCredentials>,
    "register"
  >;
  readonly createRunner: RuntimeJobRunnerFactory;
}): (
  requestServices: RuntimeJobServices,
  handoff?: boolean,
) => RuntimeJobExecutor {
  const { store, eventBus, registry } = deps;
  const createJobRunner = deps.createRunner;
  /** Re-check what the job was admitted under before spending provider work. */
  const admitJob = async (
    job: RuntimeJobRecord,
    expected: {
      readonly expectedSessionIncarnation: string;
      readonly expectedApprovalScope: string;
    },
  ): Promise<readonly RuntimeManifest[]> => {
    const live = await store.getSession(job.sessionId);
    if (
      !live ||
      live.status !== "active" ||
      sessionIncarnationIdentity(live) !==
        expected.expectedSessionIncarnation ||
      sessionApprovalScope(live, job.pluginId) !==
        expected.expectedApprovalScope
    ) {
      throw new RuntimeJobNoLongerCurrentError();
    }
    registry.syncSessionActivations(job.sessionId, live.activePlugins);
    return registry.getActiveRuntimes(job.sessionId);
  };

  /**
   * Background manual RPC calls and event followers. A failure the runtime
   * reports in its own result still commits its writes; followers it emitted
   * are queued in the same transaction and inherit its credentials.
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
    const followers: QueuedActivatedRuntimeJob[] = [];
    const completeInTx = async (
      tx: StoreTransaction,
      turnResult: TurnResult,
    ): Promise<void> => {
      const settlement = settleActivatedRun({
        activation: payload.activation,
        runtimeId: job.runtimeId,
        turnResult,
        ...(payload.expectFollower ? { expectFollower: true } : {}),
      });
      followers.push(
        ...(await enqueueEventFollowers(tx, {
          sessionId: job.sessionId,
          activeRuntimes,
          followers: settlement.followers,
          sourceTurnId: turnResult.turnId,
          sourceRuntimeId: job.runtimeId,
          locale: payload.locale,
          ...(payload.userSettings
            ? { userSettings: payload.userSettings }
            : {}),
        })),
      );
      const result = {
        turnId: turnResult.turnId,
        executionId: turnResult.executionContext.executionId,
        runtimeId: job.runtimeId,
        durationMs: turnResult.durationMs,
        runtimeResults: settlement.runtimeResults,
        ...(followers.length > 0
          ? {
              deferredJobs: followers.map(({ job: queued }) => ({
                jobId: queued.jobId,
                runtimeId: queued.runtimeId,
              })),
            }
          : {}),
      };
      if (settlement.failure)
        await control.failInTx(tx, { ...settlement.failure, result });
      else await control.completeInTx(tx, result);
    };
    const queuedRun = {
      executionSignal: control.signal,
      expectedSessionIncarnation: payload.expectedSessionIncarnation,
      beforeExecute: control.assertCurrent,
      beforeCommit: control.beforeCommit,
      completeInTx,
      ...(payload.userSettings ? { userSettings: payload.userSettings } : {}),
    };
    const retrySeedResults = payload.retryFromTurnId
      ? (topLevelTurnResults(await store.listTurnResults(job.sessionId)).find(
          (row) => row.turnId === payload.retryFromTurnId,
        )?.runtimeResults as readonly RuntimeResult[] | undefined)
      : undefined;
    const commit =
      payload.activation === "manual"
        ? (
            await runner.runManualTurn({
              ...queuedRun,
              turnId: payload.turnId,
              runtimeId: job.runtimeId,
              detached: true,
              ...(payload.input !== undefined
                ? { payload: payload.input }
                : {}),
              ...(retrySeedResults
                ? {
                    retrySeedResults,
                    sourceTurnId: payload.retryFromTurnId,
                  }
                : {}),
            })
          ).commit
        : (
            await runner.runDeferredFollowerTurn({
              ...queuedRun,
              followerTurnId: payload.turnId,
              runtimeId: job.runtimeId,
              triggerEvent: payload.triggerEvent!,
            })
          ).commit;
    if (!commit.committed) {
      throw new Error(commit.error ?? "runtime job proposals did not commit");
    }
    for (const queued of followers) {
      if (handoff)
        deps.credentials?.register(queued.credentialKey, requestServices);
      publishRuntimeJobStatusEvent(eventBus, queued.status);
    }
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
        completeInTx: async (tx, turnResult) => {
          const runtimeResult = turnResult.runtimeResults.find(
            (result) => result.runtimeId === job.runtimeId,
          );
          if (runtimeResult?.status !== "success") {
            throw new Error(
              runtimeResult?.error ??
                `detached runtime ended with ${runtimeResult?.status ?? "no result"}`,
            );
          }
          const runtimeOutput = runtimeResult.output;
          if (
            runtimeOutput?.status === "failed" ||
            (typeof runtimeOutput?.error === "string" && runtimeOutput.error)
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
        executionSignal: control.signal,
      });
      if (!outcome.commit.committed) {
        throw new Error(
          outcome.commit.error ?? "detached runtime proposals did not commit",
        );
      }
    };

  return executeRuntimeJob;
}
