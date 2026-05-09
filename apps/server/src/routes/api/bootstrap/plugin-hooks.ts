import {
  createHookPipeline,
  registerPluginHooks,
  type HookPipeline,
  type PluginHookSource,
} from "@covel/runtime";
import type {
  ParsedPluginMd,
  PluginDiscoveryResult,
} from "@covel/plugin-loader";

export interface CreateBootstrapHookPipelineParams {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
}

export function createBootstrapHookPipeline({
  discoveryMap,
  manifestCache,
}: CreateBootstrapHookPipelineParams): HookPipeline {
  const hookPipeline: HookPipeline = createHookPipeline();
  const hookSources: PluginHookSource[] = [];
  for (const [pluginId, manifests] of manifestCache) {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) continue;
    for (const parsed of manifests) {
      const hooks = parsed.manifest.hooks ?? [];
      if (hooks.length === 0) continue;
      hookSources.push({
        pluginId,
        rootPath: discovery.rootPath,
        hooks,
      });
    }
  }

  const registeredHookCount = registerPluginHooks(hookPipeline, hookSources);
  if (registeredHookCount > 0) {
    console.log(
      `[bootstrap] registered ${registeredHookCount} plugin hook handler(s) across ${hookSources.length} source(s)`,
    );
  }

  return hookPipeline;
}
