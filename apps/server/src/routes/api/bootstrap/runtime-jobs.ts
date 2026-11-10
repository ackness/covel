/**
 * Bootstrap stage 8: the durable runtime-job queue — request credential
 * handoff, the per-job turn runner, the executor, the worker, and the settle
 * barrier that waits for a session's runnable jobs.
 *
 * The worker is built here but first woken by the maintenance stage, after
 * the whole API is assembled.
 */

import type { EventBus } from "@covel/events";
import {
  pluginRuntimeManifests,
  resolvePluginRuntimeManifest,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { estimateTokens } from "@covel/context";
import type { MemorySystem } from "@covel/memory";
import { withRequestLlmOptions } from "../../../request-llm-context.js";
import { resolveMediaImageFlow } from "../media-image-flow.js";
import {
  listSettlingRuntimeJobs,
  markRunnableSettlingJobs,
  type RuntimeJobRecord,
} from "../plugin-rpc/jobs.js";
import {
  createRuntimeJobCredentials,
  type RuntimeJobServices,
} from "../plugin-rpc/runtime-job-credentials.js";
import { createRuntimeJobExecutor } from "../plugin-rpc/runtime-job-executor.js";
import {
  createRuntimeJobWorker,
  parseActivatedRuntimeJobPayload,
  parseStagedRuntimeJobPayload,
  runtimeJobIncarnation,
  type RuntimeJobExecutor,
  type RuntimeJobWorker,
} from "../plugin-rpc/runtime-job-worker.js";
import { createPluginRpcRuntimeTurnRunner } from "../plugin-rpc/runtime-turn.js";
import {
  createSettledSessionLock,
  type SettledSessionLock,
} from "../plugin-rpc/settled-session-lock.js";
import { scopeSessionEvents } from "../session/session-events.js";
import { publicIncarnationTag } from "../session/session-guard.js";
import type { ApiBootstrapConfig } from "./config.js";
import type { BootstrapModelContext } from "./model-context.js";
import type { BootstrapPluginActivation } from "./plugin-activation.js";
import type { BootstrapPluginCatalog } from "./plugin-catalog.js";
import type { BootstrapPluginHost } from "./plugin-host.js";
import { pluginDatasetsLoader } from "./runtime-loader.js";
import type { BootstrapStorage } from "./storage.js";

export interface BootstrapRuntimeJobs {
  readonly runtimeJobCredentials: ReturnType<
    typeof createRuntimeJobCredentials
  >;
  readonly runtimeJobWorker: RuntimeJobWorker;
  readonly settledSessionLock: SettledSessionLock;
}

export function createBootstrapRuntimeJobs(args: {
  readonly config: Pick<
    ApiBootstrapConfig,
    | "llmAdapter"
    | "pluginGateway"
    | "pluginUtils"
    | "mediaStore"
    | "canRunRuntimeJobWithServerServices"
  >;
  readonly storage: BootstrapStorage;
  readonly eventBus: EventBus;
  readonly catalog: BootstrapPluginCatalog;
  readonly host: BootstrapPluginHost;
  readonly activation: BootstrapPluginActivation;
  readonly model: BootstrapModelContext;
  readonly memorySystem: MemorySystem;
}): BootstrapRuntimeJobs {
  const { config, storage, eventBus, catalog, host, activation, model } = args;
  const { store, sessionLock, tryWithCommitLock } = storage;
  const { registry, eventDirectory } = catalog;
  const { services, extensions, hookPipeline, pluginFaults, loadRuntimeFn } =
    host;
  const { toolExecutor } = host.tools;
  const { withPluginSnapshot } = activation;
  const { resolveModel, compactorRunner, turnContextBudget } = model;

  const runtimeJobCredentials = createRuntimeJobCredentials();
  const createJobRunner = (
    job: RuntimeJobRecord,
    requestServices: RuntimeJobServices,
    activeRuntimes: readonly RuntimeManifest[],
    session: {
      readonly locale: string;
      readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
    },
    expectedApprovalScope: string,
  ) => {
    const incarnation = runtimeJobIncarnation(job.payload);
    if (!incarnation)
      throw new Error("Runtime job is missing its session incarnation");
    return createPluginRpcRuntimeTurnRunner({
      memorySystem: args.memorySystem,
      pluginRegistry: registry,
      store,
      eventBus: scopeSessionEvents(
        eventBus,
        job.sessionId,
        publicIncarnationTag(incarnation),
      ),
      sessionLock,
      sessionId: job.sessionId,
      withSnapshot: (fn, beforeCapture) =>
        withPluginSnapshot(job.sessionId, fn, beforeCapture),
      session: {
        locale: session.locale,
        ...(session.runtimeModelOverrides
          ? { runtimeModelOverrides: session.runtimeModelOverrides }
          : {}),
      },
      activeRuntimes,
      approvalScopes: new Map([[job.pluginId, expectedApprovalScope]]),
      deps: {
        pluginFaults,
        loadRuntime: (manifest, locale) =>
          loadRuntimeFn(manifest, locale, job.sessionId),
        loadPluginDatasets: pluginDatasetsLoader(registry),
        llm: requestServices.llm,
        services,
        extensions,
        ...(requestServices.gateway
          ? { gateway: requestServices.gateway }
          : {}),
        ...(config.pluginUtils ? { utils: config.pluginUtils } : {}),
        ...(config.mediaStore ? { mediaStore: config.mediaStore } : {}),
        toolExecutor,
        resolveModel,
        compactor: requestServices.compactor ?? compactorRunner,
        estimator: estimateTokens,
        contextBudget: turnContextBudget,
        eventDirectory,
      },
      hookPipeline,
      resolveImageFlowRuntimeIds: async () =>
        (await resolveMediaImageFlow(store, extensions, job.sessionId))
          ?.assetRuntimeIds,
    });
  };

  const executeRuntimeJob = createRuntimeJobExecutor({
    store,
    eventBus,
    registry,
    credentials: runtimeJobCredentials,
    createRunner: createJobRunner,
  });
  // Shared by the worker's claim and the settle barrier's runnable check.
  const prepareRuntimeJobExecution = (
    job: RuntimeJobRecord,
  ): RuntimeJobExecutor | undefined => {
    const payload =
      parseStagedRuntimeJobPayload(job.payload) ??
      parseActivatedRuntimeJobPayload(job.payload);
    if (!payload) return executeRuntimeJob({ llm: config.llmAdapter });
    const key = {
      jobId: job.jobId,
      sessionId: job.sessionId,
      expectedSessionIncarnation: payload.expectedSessionIncarnation,
    };
    const entry = registry.get(job.pluginId);
    const parsed =
      entry &&
      pluginRuntimeManifests(entry).find(
        ({ manifest }) => manifest.name === job.runtimeId,
      );
    const manifest =
      entry && parsed
        ? resolvePluginRuntimeManifest(entry, parsed.manifest)
        : undefined;
    const modelOverride =
      "modelOverride" in payload ? payload.modelOverride : undefined;
    const override =
      manifest?.outputKind === "story" && modelOverride
        ? modelOverride
        : payload.runtimeModelOverrides?.[job.runtimeId];
    // The worker may drain inside an unrelated request's scope. Resolve the
    // job's model under the configuration of the services that will run it.
    const modelFor = (services: RuntimeJobServices | undefined) =>
      withRequestLlmOptions(services?.llmOptions, () =>
        manifest ? resolveModel(manifest, override) : override,
      );
    let selectedServices = runtimeJobCredentials.peek(key);
    let handoff = selectedServices !== undefined;
    if (selectedServices?.canRun) {
      let ready = false;
      try {
        ready = selectedServices.canRun(modelFor(selectedServices));
      } catch {
        /* Fail closed. */
      }
      if (!ready) {
        // An unusable handoff must not block the next authenticated request.
        runtimeJobCredentials.discard(key);
        selectedServices = undefined;
        handoff = false;
      }
    }
    if (!selectedServices) {
      if (
        !config.canRunRuntimeJobWithServerServices?.({
          job,
          model: modelFor(undefined),
        })
      )
        return undefined;
      selectedServices = {
        llm: config.llmAdapter,
        gateway: config.pluginGateway,
        compactor: compactorRunner,
      };
    }
    // The executor restores the selected services' LLM scope around the job.
    const execute = executeRuntimeJob(selectedServices, handoff);
    return async (claimed, control) => {
      runtimeJobCredentials.discard(key);
      await execute(claimed, control);
    };
  };
  const runtimeJobWorker = createRuntimeJobWorker({
    store,
    eventBus,
    tryWithCommitLock,
    execute: executeRuntimeJob({
      llm: config.llmAdapter,
      gateway: config.pluginGateway,
      compactor: compactorRunner,
    }),
    prepareExecution: prepareRuntimeJobExecution,
  });
  const settledSessionLock = createSettledSessionLock({
    sessionLock,
    // Runs after the request handed its credentials over, so a job its
    // credentials can serve counts as runnable.
    listPendingJobs: async (sessionId) =>
      markRunnableSettlingJobs(
        await listSettlingRuntimeJobs(store, sessionId),
        (job) => prepareRuntimeJobExecution(job) !== undefined,
      ),
    wake: (sessionId) => runtimeJobWorker.wake(sessionId),
  });
  return { runtimeJobCredentials, runtimeJobWorker, settledSessionLock };
}
