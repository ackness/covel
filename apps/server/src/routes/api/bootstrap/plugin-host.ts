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
import { refreshDeclarativeEligibility } from "../../../trust/plugin-admission.js";
import {
  createHostPluginFaults,
  type HostPluginFaults,
} from "../plugin-faults.js";
import { RecentPluginServiceCalls } from "../plugin-diagnostics.js";
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

export interface BootstrapPluginHost {
  readonly runtimeLoader: RuntimeLoader;
  readonly loadRuntimeFn: RuntimeLoader["loadRuntimeFn"];
  readonly tools: PluginToolsResult;
  readonly rpc: BootstrapPluginRpc;
  readonly pluginFaultHost: HostPluginFaults;
  readonly pluginFaults: HostPluginFaults["latch"];
  readonly serviceCalls: RecentPluginServiceCalls;
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
}): Promise<BootstrapPluginHost> {
  const { storage, eventBus, catalog, trust, owned } = args;
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
  });

  const pluginFaultHost = createHostPluginFaults({ store, eventBus, registry });
  const pluginFaults = pluginFaultHost.latch;
  const serviceCalls = new RecentPluginServiceCalls();
  const serviceAdmission = createPluginServiceAdmission({
    pluginFaults,
    store,
    registry,
    ensurePluginEntry: (pluginId, sessionId) =>
      runtimeLoader.ensurePluginEntry(pluginId, sessionId),
    isEntryRetryDeferred: (pluginId) =>
      owned.pluginEntries?.isEntryRetryDeferred(pluginId) ?? false,
  });
  const services = new PluginServiceRegistry(
    {
      onCallCompleted: (event) => serviceCalls.record(event),
      ...serviceAdmission.admission,
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
    pluginFaultHost,
    pluginFaults,
    serviceCalls,
    serviceAdmission,
    services,
    extensions,
    hookPipeline,
  };
}
