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
import { scopeStoreToPlugin } from "./plugin-store-scope.js";

export interface BootstrapLocalToolsParams {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
  readonly toolMap: Map<string, ToolModule>;
  readonly localToolNames: Set<string>;
}

export interface BootstrapLocalTools {
  readonly activatePluginLocalTools: (pluginId: string) => Promise<void>;
  /** Mutable on purpose: the unified `entry` registration path adds
   *  entry-registered tool names at invocation time (plugin-entry.ts). */
  readonly pluginToolAccess: Map<string, Set<string>>;
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

  const pluginToolAccess = buildPluginToolAccess(manifestCache);

  // Reject collisions: builtins are registered before local tools, so a
  // duplicate name here would silently replace a builtin (or another
  // plugin's tool) for every runtime that references it. Ownership (the
  // allowlist entry) is granted ONLY on successful registration — a skipped
  // collision must not leave the declaring plugin authorized to execute the
  // other plugin's implementation via the global toolMap.
  const addLocalTool = (pluginId: string, t: ToolModule): void => {
    if (toolMap.has(t.name)) {
      console.warn(
        `[plugin-loader] ${pluginId}: local tool "${t.name}" collides with an existing tool — skipping`,
      );
      return;
    }
    toolMap.set(t.name, t);
    localToolNames.add(t.name);
    let allowed = pluginToolAccess.get(pluginId);
    if (!allowed) {
      allowed = new Set();
      pluginToolAccess.set(pluginId, allowed);
    }
    allowed.add(t.name);
  };

  for (const [pluginId, discovery] of discoveryMap) {
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (!trust.autoLoad) continue;
    for (const t of await loadLocalToolsForPlugin(pluginId)) {
      addLocalTool(pluginId, t);
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
          addLocalTool(pluginId, t);
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
    pluginToolAccess,
  };
}

/**
 * Seed the per-plugin allowlist from manifest declarations — builtin names
 * only. Local (`tools.local`) and entry-registered (`tools.plugin`) names are
 * added at successful registration time (addLocalTool above / registerTool in
 * plugin-entry.ts): granting them from the declaration alone would let a
 * plugin execute another plugin's same-named tool through the global toolMap
 * (audit 2026-07-10 A-01). A declared-but-unregistered name simply fails to
 * resolve for the declaring plugin.
 */
export function buildPluginToolAccess(
  manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>,
): Map<string, Set<string>> {
  const pluginToolAccess = new Map<string, Set<string>>();
  for (const [pluginId, manifests] of manifestCache) {
    const allowed = new Set<string>();
    for (const parsed of manifests) {
      for (const t of parsed.manifest.tools?.builtin ?? []) allowed.add(t);
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
  return async (pluginId: string): Promise<readonly ToolModule[]> => {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return [];
    const manifests = manifestCache.get(pluginId);
    if (!manifests) return [];
    // Same trust split as the unified `entry` path (plugin-entry.ts): a
    // community factory closes over this store for the process lifetime and
    // cannot be bound to a request session, so it gets the deny-all view.
    // Builtin/official keep the raw store.
    const toolInjection = {
      tool,
      z,
      shortId,
      shortIdBatch,
      withPendingProposals,
      store:
        getPluginTrustInfo(pluginId, discovery.source).source === "community"
          ? scopeStoreToPlugin(store, pluginId, "local-tools")
          : store,
    };
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
