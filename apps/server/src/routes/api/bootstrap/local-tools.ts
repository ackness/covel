import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getPluginTrustInfo,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import {
  shortId,
  shortIdBatch,
  tool,
  withPendingProposals,
  type ToolModule,
} from "@covel/tools";
import { z } from "zod";

export interface BootstrapLocalToolsParams {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
  readonly toolMap: Map<string, ToolModule>;
  readonly localToolNames: Set<string>;
}

export interface BootstrapLocalTools {
  readonly activatePluginLocalTools: (pluginId: string) => Promise<void>;
  readonly pluginToolAccess: ReadonlyMap<string, ReadonlySet<string>>;
}

export async function createBootstrapLocalTools({
  discoveryMap,
  manifestCache,
  store,
  toolMap,
  localToolNames,
}: BootstrapLocalToolsParams): Promise<BootstrapLocalTools> {
  const loadLocalToolsForPlugin = createLocalToolLoader({
    discoveryMap,
    manifestCache,
    store,
  });

  for (const [pluginId, discovery] of discoveryMap) {
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (!trust.autoLoad) continue;
    for (const t of await loadLocalToolsForPlugin(pluginId)) {
      toolMap.set(t.name, t);
      localToolNames.add(t.name);
    }
  }

  const activatedPluginIds = new Set<string>();
  const activationInFlight = new Map<string, Promise<void>>();

  const activatePluginLocalTools = async (pluginId: string): Promise<void> => {
    if (activatedPluginIds.has(pluginId)) return;
    const inFlight = activationInFlight.get(pluginId);
    if (inFlight) return inFlight;

    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return;
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (trust.autoLoad) {
      activatedPluginIds.add(pluginId);
      return;
    }

    const promise = (async () => {
      try {
        for (const t of await loadLocalToolsForPlugin(pluginId)) {
          toolMap.set(t.name, t);
          localToolNames.add(t.name);
        }
        activatedPluginIds.add(pluginId);
      } finally {
        activationInFlight.delete(pluginId);
      }
    })();
    activationInFlight.set(pluginId, promise);
    return promise;
  };

  return {
    activatePluginLocalTools,
    pluginToolAccess: buildPluginToolAccess(manifestCache),
  };
}

export function buildPluginToolAccess(
  manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>,
): Map<string, Set<string>> {
  const pluginToolAccess = new Map<string, Set<string>>();
  for (const [pluginId, manifests] of manifestCache) {
    const allowed = new Set<string>();
    for (const parsed of manifests) {
      for (const t of parsed.manifest.tools?.builtin ?? []) allowed.add(t);
      for (const p of parsed.manifest.tools?.local ?? []) {
        const basename =
          p
            .split("/")
            .pop()
            ?.replace(/\.[^.]+$/, "") ?? p;
        allowed.add(basename);
      }
    }
    pluginToolAccess.set(pluginId, allowed);
  }
  return pluginToolAccess;
}

export function createLocalToolLoader({
  discoveryMap,
  manifestCache,
  store,
}: {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
}): (pluginId: string) => Promise<readonly ToolModule[]> {
  const toolInjection = {
    tool,
    z,
    shortId,
    shortIdBatch,
    withPendingProposals,
    store,
  };

  return async (pluginId: string): Promise<readonly ToolModule[]> => {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return [];
    const manifests = manifestCache.get(pluginId);
    if (!manifests) return [];
    const collected: ToolModule[] = [];
    for (const parsed of manifests) {
      const localPaths = parsed.manifest.tools?.local ?? [];
      for (let i = 0; i < localPaths.length; i += 1) {
        const localPath = localPaths[i];
        const fullPath = path.resolve(discovery.rootPath, localPath);
        const pluginRelPath = path.relative(
          process.cwd(),
          path.join(discovery.rootPath, "PLUGIN.md"),
        );
        try {
          const rel = path.relative(discovery.rootPath, fullPath);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            console.warn(
              `[plugin-loader] ${pluginRelPath}: tools.local[${i}] "${localPath}" escapes the plugin root\n` +
                `Fix: Use a path relative to the plugin directory (no "../" traversal).`,
            );
            continue;
          }
          if (!fsSync.existsSync(fullPath)) {
            console.warn(
              `[plugin-loader] ${pluginRelPath}: tool file not found — ${fullPath} (declared in tools.local[${i}] as "${localPath}")\n` +
                `Fix: Create the file, or remove the entry from tools.local in PLUGIN.md.`,
            );
            continue;
          }
          const mod = await import(pathToFileURL(fullPath).href);
          const exported = mod.default ?? Object.values(mod)[0];

          const toolModule = resolveToolModule(exported, toolInjection);
          if (toolModule) collected.push(toolModule);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[plugin-loader] ${pluginRelPath}: failed to load tools.local[${i}] "${localPath}" — ${message}\n` +
              `Fix: Ensure ${fullPath} exports a tool module (factory or ToolModule with _type: 'covel-tool').`,
          );
        }
      }
    }
    return collected;
  };
}

function resolveToolModule(
  exported: unknown,
  toolInjection: {
    readonly tool: typeof tool;
    readonly z: typeof z;
    readonly shortId: typeof shortId;
    readonly shortIdBatch: typeof shortIdBatch;
    readonly withPendingProposals: typeof withPendingProposals;
    readonly store: DataStore;
  },
): ToolModule | undefined {
  if (typeof exported === "function") {
    const result = exported(toolInjection);
    if (isToolModule(result)) return result;
  } else if (isToolModule(exported)) {
    return exported;
  }
  return undefined;
}

function isToolModule(value: unknown): value is ToolModule {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as Record<string, unknown>)._type === "covel-tool"
  );
}
