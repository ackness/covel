/**
 * Wire the API dependency graph for production and tests.
 *
 * `bootstrapApi` runs the stages under `bootstrap/` in order. Each stage
 * returns a typed bundle the later ones consume; the order is the order
 * resources are acquired, and a failure releases what was acquired so far.
 */

import { createUiSlotHost } from "../../ui-slots/host.js";
import { mountApiRoutes } from "./bootstrap/api-routes.js";
import type {
  ApiBootstrapConfig,
  ApiBootstrapResult,
} from "./bootstrap/config.js";
import {
  createBootstrapEventBus,
  releaseAfterStartupFailure,
  type BootstrapOwned,
} from "./bootstrap/event-infrastructure.js";
import { startBootstrapMaintenance } from "./bootstrap/maintenance.js";
import { wireBootstrapMemory } from "./bootstrap/memory.js";
import { createBootstrapModelContext } from "./bootstrap/model-context.js";
import { activatePluginEntries } from "./bootstrap/plugin-activation.js";
import { discoverBootstrapPlugins } from "./bootstrap/plugin-catalog.js";
import { createPluginHost } from "./bootstrap/plugin-host.js";
import { createBootstrapRuntimeJobs } from "./bootstrap/runtime-jobs.js";
import {
  loadServerTrust,
  type TrustedSourcesRef,
} from "./bootstrap/server-trust.js";
import { createBootstrapStorage } from "./bootstrap/storage.js";

export type {
  ApiBootstrapConfig,
  ApiBootstrapResult,
} from "./bootstrap/config.js";
export { wrapStoreWithPluginDataEvents } from "./bootstrap/plugin-data-store-events.js";

/** Discover plugins, construct shared services, inject dependencies, and mount routes. */
export async function bootstrapApi(
  config: ApiBootstrapConfig,
): Promise<ApiBootstrapResult> {
  const owned: BootstrapOwned = {};
  try {
    const eventBus = await createBootstrapEventBus(config, owned);
    const storage = createBootstrapStorage(config, eventBus);
    const { store, sessionLock } = storage;
    const catalog = await discoverBootstrapPlugins(config, eventBus);
    const { registry } = catalog;
    // Filled by the trust stage once server settings are loaded; read at
    // call time by everything built before it.
    const trust: TrustedSourcesRef = { current: undefined };
    const host = await createPluginHost({
      storage,
      eventBus,
      catalog,
      trust,
      owned,
    });
    const activation = await activatePluginEntries({
      storage,
      catalog,
      host,
      trust,
      owned,
      uiSlots: () => uiSlots,
    });
    // From `watch()` above until the UI slot host exists, nothing awaits:
    // a plugin reload cannot reach `uiSlots` before it is built.
    const model = createBootstrapModelContext({
      extensions: host.extensions,
      store,
      llmAdapter: config.llmAdapter,
    });
    const { memorySystem } = wireBootstrapMemory({
      store,
      registry,
      tools: host.tools.tools,
      memoryIngestLock: storage.memoryIngestLock,
      config,
    });
    const jobs = createBootstrapRuntimeJobs({
      config,
      storage,
      eventBus,
      catalog,
      host,
      activation,
      model,
      memorySystem,
    });
    // Subscribes to the event bus, after the runtime-job worker.
    const uiSlots = createUiSlotHost({
      store,
      eventBus,
      extensionHost: host.extensions,
      services: host.services,
    });
    const { app, applicationWork } = mountApiRoutes({
      config,
      storage,
      eventBus,
      catalog,
      host,
      activation,
      model,
      memorySystem,
      jobs,
      uiSlots,
      trust,
    });
    const trustedSources = await loadServerTrust({
      config,
      runtimeEnv: model.runtimeEnv,
      store,
      registry,
      app,
      trust,
    });
    const startupMaintenance = startBootstrapMaintenance({
      storeBackend: config.storeBackend,
      store,
      registry,
      sessionLock,
      eventBus,
      runtimeJobWorker: jobs.runtimeJobWorker,
    });

    const { toolExecutor, prepareToolsForSession } = host.tools;
    const { pluginEntries } = activation;
    return {
      memorySystem,
      trustedSources,
      app,
      applicationWork,
      registry,
      store,
      eventBus,
      compactorRunner: model.compactorRunner,
      runtimeJobWorker: jobs.runtimeJobWorker,
      startupMaintenance,
      closeTools: () => toolExecutor.close(),
      closePluginEntries: async () => {
        jobs.runtimeJobCredentials.clear();
        await uiSlots.close();
        await pluginEntries.close();
      },
      prepareToolsForSession,
    };
  } catch (error) {
    await releaseAfterStartupFailure(owned);
    throw error;
  }
}
