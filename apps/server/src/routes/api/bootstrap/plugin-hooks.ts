import {
  createHookPipeline,
  registerPluginHooks,
  type HookPipeline,
  type PluginHookSource,
} from "@covel/runtime";
import {
  getPluginTrustInfo,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";

export interface CreateBootstrapHookPipelineParams {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly isCommunityServerCodeApproved?: (
    sessionId: string,
    pluginId: string,
  ) => boolean;
}

export function createBootstrapHookPipeline({
  discoveryMap,
  manifestCache,
  isCommunityServerCodeApproved,
}: CreateBootstrapHookPipelineParams): HookPipeline {
  const hookPipeline: HookPipeline = createHookPipeline();
  const hookSources: PluginHookSource[] = [];
  for (const [pluginId, manifests] of manifestCache) {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) continue;
    // Trust gate (H-03): community (non-autoLoad) plugins register their hook
    // DECLARATIONS at boot, but the handlers stay dormant — never import()'d
    // nor executed — until `ensurePluginEntry` activates the plugin at
    // approval, mirroring the deferred entry / local-tool / wire boot paths.
    const deferred = !getPluginTrustInfo(pluginId, discovery.source).autoLoad;
    for (const parsed of manifests) {
      const hooks = parsed.manifest.hooks ?? [];
      if (hooks.length === 0) continue;
      hookSources.push({
        pluginId,
        rootPath: discovery.rootPath,
        hooks,
        deferred,
      });
    }
  }

  const registeredHookCount = registerPluginHooks(hookPipeline, hookSources, {
    isDeferredAuthorized: isCommunityServerCodeApproved,
  });
  if (registeredHookCount > 0) {
    console.log(
      `[bootstrap] registered ${registeredHookCount} plugin hook handler(s) across ${hookSources.length} source(s)`,
    );
  }

  return hookPipeline;
}
