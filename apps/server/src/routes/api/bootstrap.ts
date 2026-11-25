/**
 * Wire the API dependency graph for production and tests.
 *
 * `bootstrapApi` runs the stages under `bootstrap/` in order. Each stage
 * returns a typed bundle the later ones consume; the order is the order
 * resources are acquired, and a failure releases what was acquired so far.
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { readEnvString, readRuntimeEnv } from "@covel/shared";
import { loadOrCreateHostId } from "../../trust/host-id.js";
import { createSecretVault } from "../../trust/secret-vault.js";
import { createUiSlotHost } from "../../ui-slots/host.js";
import { mountApiRoutes } from "./bootstrap/api-routes.js";
import { createInstancePluginRegistry } from "./bootstrap/instance-plugins.js";
import { createPluginAppActionRoutes } from "./plugin-app-actions.js";
import { createPluginFlowRoutes } from "./plugin-flows.js";
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
    let configDir: string;
    if (config.covelHome) {
      configDir = config.covelHome;
    } else if (config.storeBackend === "memory") {
      configDir = mkdtempSync(path.join(tmpdir(), "covel-instance-"));
      owned.ephemeralConfigDir = configDir;
    } else {
      configDir = readRuntimeEnv().covelHome ?? path.join(homedir(), ".covel");
    }
    const hostId = await loadOrCreateHostId(configDir);
    const secretVault = createSecretVault({
      configDir,
      credentialsKey: readEnvString("COVEL_CREDENTIALS_KEY"),
    });
    // Filled by the trust stage once server settings are loaded; read at
    // call time by everything built before it.
    const trust: TrustedSourcesRef = { current: undefined };
    const host = await createPluginHost({
      storage,
      eventBus,
      catalog,
      trust,
      owned,
      hostId,
      secretVault,
    });
    const activation = await activatePluginEntries({
      storage,
      catalog,
      host,
      trust,
      owned,
      hostId,
      secretVault,
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
      getPermissionService: () => trust.permissions,
    });
    // Subscribes to the event bus, after the runtime-job worker.
    const uiSlots = createUiSlotHost({
      store,
      pluginRegistry: registry,
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
      secretVault,
    });
    const { trustedSources, permissionService } = await loadServerTrust({
      config,
      runtimeEnv: model.runtimeEnv,
      store,
      registry,
      app,
      trust,
      rpcApprovalGate: host.rpc.rpcApprovalGate,
    });
    permissionService.onChange((pluginId) => {
      if (pluginId) {
        host.providerSources.invalidatePlugin(pluginId);
      } else {
        host.providerSources.invalidateAll();
      }
    });
    const instancePlugins = (owned.instancePlugins =
      createInstancePluginRegistry({
        registry,
        pluginEntries: activation.pluginEntries,
        permissionService,
        trustedSources,
      }));
    app.route(
      "/api/plugins",
      createPluginAppActionRoutes({
        registry,
        store,
        hostId,
        secretVault,
        appActions: host.appActions,
        appScheduler: host.appScheduler,
        instancePlugins,
        permissionService,
        trustedSources,
        providerSources: host.providerSources,
      }),
    );
    app.route(
      "/api/plugins",
      createPluginFlowRoutes({
        registry,
        store,
        hostId,
        secretVault,
        configFlows: host.configFlows,
        instancePlugins,
        permissionService,
        trustedSources,
        providerSources: host.providerSources,
      }),
    );
    await instancePlugins.activateForEvent("onStartup");
    for (const plugin of instancePlugins.listInstancePlugins()) {
      if (
        plugin.allowed &&
        !plugin.activated &&
        plugin.activationEvents.some((ev) => ev.startsWith("onSchedule:"))
      ) {
        await instancePlugins.activate(plugin.pluginId).catch((error) => {
          console.warn(
            `[bootstrap] scheduled instance plugin "${plugin.pluginId}" failed to activate:`,
            error,
          );
        });
      }
    }
    await host.providerSources.warmStatus();
    await host.appEvents.emit("AppStarted", {
      hostId,
      startedAt: new Date().toISOString(),
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
      permissionService,
      hostId,
      secretVault,
      instancePlugins,
      providerSources: host.providerSources,
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
        await host.appEvents
          .emit("BeforeShutdown", { hostId, reason: "shutdown" })
          .catch(() => {});
        await host.appScheduler.close();
        await host.configFlows.close();
        await uiSlots.close();
        await pluginEntries.close();
        if (owned.ephemeralConfigDir) {
          await rm(owned.ephemeralConfigDir, {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
      },
      prepareToolsForSession,
    };
  } catch (error) {
    await releaseAfterStartupFailure(owned);
    throw error;
  }
}
