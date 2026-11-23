/**
 * Bootstrap stage 4: the capability surfaces plugin code registers into —
 * the approved runtime loader, the tool registry and its approval-gated
 * executor, the RPC registry and approval gate, plugin services, extension
 * points and the hook pipeline — before any plugin entry runs.
 */

import type { EventBus } from "@covel/events";
import {
  PluginExtensionHost,
  PluginServiceRegistry,
  createHookPipeline,
  type HookPipeline,
} from "@covel/runtime";
import type { SecretVault } from "../../../trust/secret-vault.js";
import { refreshDeclarativeEligibility } from "../../../trust/plugin-admission.js";
import {
  checkInstancePluginAllowed,
  isPluginCapabilityEffectivelyAllowed,
} from "./instance-plugins.js";
import {
  buildPluginInstanceSurface,
  packageHttpPermissions,
  pickPluginInstanceSurfaceFields,
} from "./plugin-entry-api.js";
import {
  createHostPluginFaults,
  type HostPluginFaults,
} from "../plugin-faults.js";
import {
  RecentPluginServiceCalls,
  RecentPromptDiagnostics,
} from "../plugin-diagnostics.js";
import type { BootstrapOwned } from "./event-infrastructure.js";
import type { BootstrapPluginCatalog } from "./plugin-catalog.js";
import {
  createBootstrapPluginRpc,
  type BootstrapPluginRpc,
} from "./plugin-rpc-wiring.js";
import { createPluginServiceAdmission } from "./plugin-service-admission.js";
import { createRuntimeLoader, type RuntimeLoader } from "./runtime-loader.js";
import type { TrustedSourcesRef } from "./server-trust.js";
import type { BootstrapStorage } from "./storage.js";
import { setupPluginTools, type PluginToolsResult } from "./tools.js";
import {
  createAppActionRegistry,
  type AppActionRegistry,
} from "./app-actions.js";
import {
  createConfigFlowEngine,
  type ConfigFlowEngine,
} from "./config-flows.js";
import {
  createAppEventDispatcher,
  linkAppEventDispatcherToBus,
  type AppEventDispatcher,
} from "./app-events.js";
import { createAppScheduler, type AppScheduler } from "./app-scheduler.js";
import {
  createProviderSourceHost,
  type ProviderSourceHost,
} from "./provider-sources.js";

export interface BootstrapPluginHost {
  readonly runtimeLoader: RuntimeLoader;
  readonly loadRuntimeFn: RuntimeLoader["loadRuntimeFn"];
  readonly tools: PluginToolsResult;
  readonly rpc: BootstrapPluginRpc;
  readonly appActions: AppActionRegistry;
  readonly configFlows: ConfigFlowEngine;
  readonly appEvents: AppEventDispatcher;
  readonly appScheduler: AppScheduler;
  readonly providerSources: ProviderSourceHost;
  readonly pluginFaultHost: HostPluginFaults;
  readonly pluginFaults: HostPluginFaults["latch"];
  readonly serviceCalls: RecentPluginServiceCalls;
  readonly promptDiagnostics: RecentPromptDiagnostics;
  readonly serviceAdmission: ReturnType<typeof createPluginServiceAdmission>;
  readonly services: PluginServiceRegistry;
  readonly extensions: PluginExtensionHost;
  readonly hookPipeline: HookPipeline;
}

export async function createPluginHost(args: {
  readonly storage: BootstrapStorage;
  readonly eventBus: EventBus;
  readonly catalog: BootstrapPluginCatalog;
  readonly trust: TrustedSourcesRef;
  readonly owned: BootstrapOwned;
  readonly hostId?: string;
  readonly secretVault?: SecretVault;
}): Promise<BootstrapPluginHost> {
  const { storage, eventBus, catalog, trust, owned, hostId, secretVault } =
    args;
  const { store } = storage;
  const { registry, discoveryMap, manifestCache, eventDirectory } = catalog;

  // Runtime loader + community dual-authorization gate (runtime-loader.ts).
  // It forward-references two things built later: the rpc approval gate
  // (lazy getter, below in this stage) and the real `ensurePluginEntry`
  // (late-bound no-op seam, assigned via `bindPluginEntry` once plugin
  // entries exist). See the ORDERING CONSTRAINT in runtime-loader.ts for the
  // full contract.
  const runtimeLoader = createRuntimeLoader({
    pluginRegistry: registry,
    discoveryMap,
    manifestCache,
    store,
    getApprovalGate: () => rpc.rpcApprovalGate,
    refreshDeclarativeEligibility: (pluginId) =>
      refreshDeclarativeEligibility(trust.current, pluginId),
  });
  const loadRuntimeFn = runtimeLoader.loadRuntimeFn;

  // ToolExecutor with builtin + plugin local tools + approval (tools.ts):
  // the framework tool registry, per-session character-tool overrides, and
  // the approval-gated executor. The registry remains mutable so the memory
  // system can register its tools in a later stage.
  const tools = await setupPluginTools({ store, eventDirectory });
  owned.closeTools = () => tools.toolExecutor.close();

  const rpc = createBootstrapPluginRpc({
    implicitGrant: (query) => trust.current?.implicitGrant(query) ?? false,
    policyDecision: (query) =>
      trust.permissions
        ? trust.permissions.evaluateRpcApproval(query)
        : trust.current?.implicitGrant(query)
          ? { decision: "allow", reason: "trusted-source" }
          : { decision: "ask" },
  });
  const appActions = createAppActionRegistry();
  const configFlows = createConfigFlowEngine();
  const appEvents = createAppEventDispatcher({
    registry,
    store,
    hostId,
    secretVault,
    getPermissionService: () => trust.permissions,
    getTrustedSources: () => trust.current,
    activateForEvent: (event) =>
      owned.instancePlugins?.activateForEvent(event) ?? Promise.resolve([]),
  });
  linkAppEventDispatcherToBus(eventBus, appEvents);
  const appScheduler = createAppScheduler({
    registry,
    store,
    hostId,
    secretVault,
    getPermissionService: () => trust.permissions,
    getTrustedSources: () => trust.current,
  });
  const providerSources = createProviderSourceHost({
    registry,
    store,
    hostId,
    secretVault,
    getPermissionService: () => trust.permissions,
    getTrustedSources: () => trust.current,
    getInstancePlugins: () => owned.instancePlugins,
  });

  const pluginFaultHost = createHostPluginFaults({ store, eventBus, registry });
  const pluginFaults = pluginFaultHost.latch;
  const serviceCalls = new RecentPluginServiceCalls();
  const promptDiagnostics = new RecentPromptDiagnostics();
  const serviceAdmission = createPluginServiceAdmission({
    pluginFaults,
    store,
    registry,
    ensurePluginEntry: (pluginId, sessionId) =>
      runtimeLoader.ensurePluginEntry(pluginId, sessionId),
    isEntryRetryDeferred: (pluginId) =>
      owned.pluginEntries?.isEntryRetryDeferred(pluginId) ?? false,
  });
  async function admitInstancePlugin(
    pluginId: string,
    contract?: string,
  ): Promise<boolean> {
    const allowed = await checkInstancePluginAllowed(
      {
        registry,
        permissionService: trust.permissions,
        trustedSources: trust.current,
      },
      pluginId,
    );
    if (!allowed) return false;
    if (
      contract === "channel.bridge@1" &&
      !isPluginCapabilityEffectivelyAllowed(
        trust.permissions,
        registry,
        "channel.bridge",
        pluginId,
      )
    ) {
      return false;
    }
    return true;
  }

  const services = new PluginServiceRegistry(
    {
      onCallCompleted: (event) => serviceCalls.record(event),
      ...serviceAdmission.admission,
      async instanceList(contract) {
        const admitted: string[] = [];
        for (const entry of registry.getAll().values()) {
          const scope = entry.packageManifest?.plugin.scope ?? "session";
          if (scope !== "instance" && scope !== "both") continue;
          if (!(await admitInstancePlugin(entry.id, contract))) continue;
          const activationEvents =
            entry.packageManifest?.plugin.activationEvents ?? [];
          const matchesExtension =
            contract !== undefined &&
            activationEvents.includes(`onExtension:${contract}`);
          if (
            owned.pluginEntries &&
            (matchesExtension || owned.pluginEntries.isEntryPublished(entry.id))
          ) {
            try {
              await owned.pluginEntries.ensureInstancePluginEntry(entry.id);
            } catch (error) {
              console.warn(
                `[plugin-host] skipped instance plugin ${entry.id} during extension discovery:`,
                error,
              );
              continue;
            }
          }
          if (
            !owned.pluginEntries ||
            owned.pluginEntries.isEntryPublished(entry.id)
          ) {
            admitted.push(entry.id);
          }
        }
        return admitted;
      },
      async instanceEnsure(pluginId, contract) {
        if (!(await admitInstancePlugin(pluginId, contract))) {
          throw new Error(
            `Instance plugin "${pluginId}" is not admitted${contract ? ` for contract ${contract}` : ""}`,
          );
        }
        await owned.pluginEntries?.ensureInstancePluginEntry(pluginId);
      },
      instanceContext(pluginId, signal) {
        const entry = registry.getCurrent(pluginId) ?? registry.get(pluginId);
        const surface = buildPluginInstanceSurface({
          pluginId,
          pluginRegistry: registry,
          store,
          hostId,
          secretVault,
          getPermissionService: () => trust.permissions,
          httpPermissions: entry ? packageHttpPermissions(entry) : [],
        });
        const { sandbox: _sandbox, ...surfaceWithoutSandbox } =
          pickPluginInstanceSurfaceFields(surface);
        return {
          ...surfaceWithoutSandbox,
          http: {
            validateBaseUrl: surface.http.validateBaseUrl,
            fetchWithRetry: (input, init) =>
              surface.http.fetchWithRetry(input, {
                ...init,
                signal: init?.signal ?? signal,
              }),
          },
        };
      },
    },
    (pluginId) => registry.get(pluginId)?.messages,
  );
  const extensions = new PluginExtensionHost(
    services,
    undefined,
    (pluginId) => registry.get(pluginId)?.messages,
  );
  const hookPipeline = createHookPipeline({
    onHandlerOutcome: pluginFaultHost.onHandlerOutcome,
    isPluginLatched: pluginFaults.isLatched,
  });
  return {
    runtimeLoader,
    loadRuntimeFn,
    tools,
    rpc,
    appActions,
    configFlows,
    appEvents,
    appScheduler,
    providerSources,
    pluginFaultHost,
    pluginFaults,
    serviceCalls,
    promptDiagnostics,
    serviceAdmission,
    services,
    extensions,
    hookPipeline,
  };
}
