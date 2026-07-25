import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeManifest } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
  type LoadedRuntime,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import {
  shortId,
  shortIdBatch,
  tool,
  withPendingProposals,
  z,
  type ToolModule,
} from "@covel/tools";

export interface RuntimeLoadResult {
  readonly discovery: PluginDiscoveryResult;
  readonly rawManifests: readonly RuntimeManifest[];
  readonly manifests: readonly RuntimeManifest[];
  readonly target: RuntimeManifest;
  readonly loadedCache: Map<string, LoadedRuntime>;
  readonly localTools: readonly ToolModule[];
}

export function expandPath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

export function defaultPluginsDir(): string {
  return expandPath(process.env.COVEL_USER_PLUGINS_DIR ?? "~/.covel/plugins");
}

export function pluginIdFromRuntime(runtimeId: string): string {
  return runtimeId.includes("/") ? runtimeId.split("/")[0]! : runtimeId;
}

export async function discoverPlugin(
  pluginsDir: string,
  pluginId: string,
): Promise<PluginDiscoveryResult> {
  const discoveries = await discoverPlugins(pluginsDir);
  const discovery = discoveries.find((item) => item.id === pluginId);
  if (!discovery) {
    throw new Error(`plugin "${pluginId}" not found in ${pluginsDir}`);
  }
  return discovery;
}

export async function loadRuntimeManifests(
  discovery: PluginDiscoveryResult,
): Promise<readonly RuntimeManifest[]> {
  return (await loadPluginManifest(discovery)).map((item) => item.manifest);
}

export function prepareRuntimeManifests(args: {
  readonly rawManifests: readonly RuntimeManifest[];
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly ignoreUpstreams?: boolean;
}): {
  readonly manifests: readonly RuntimeManifest[];
  readonly target: RuntimeManifest;
} {
  // Strip the upstream gate: a case run in isolation has no upstream results,
  // so any `needs` declaration would skip the target with "upstream not
  // success".
  const manifests = args.ignoreUpstreams
    ? args.rawManifests.map((manifest) => ({ ...manifest, needs: undefined }))
    : args.rawManifests;
  const target = manifests.find((manifest) => manifest.name === args.runtimeId);
  if (!target) {
    throw new Error(
      `runtime "${args.runtimeId}" not found in plugin "${args.pluginId}"`,
    );
  }
  return { manifests, target };
}

export async function loadRuntimeCache(args: {
  readonly discovery: PluginDiscoveryResult;
  readonly rawManifests: readonly RuntimeManifest[];
  readonly locale: string;
}): Promise<Map<string, LoadedRuntime>> {
  const loadedCache = new Map<string, LoadedRuntime>();
  for (const manifest of args.rawManifests) {
    loadedCache.set(
      manifest.name,
      await loadRuntime(args.discovery, manifest.name, args.locale),
    );
  }
  return loadedCache;
}

export async function loadRuntimeBundle(args: {
  readonly pluginsDir: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly locale: string;
  readonly ignoreUpstreams?: boolean;
  readonly store?: DataStore;
}): Promise<RuntimeLoadResult> {
  const discovery = await discoverPlugin(args.pluginsDir, args.pluginId);
  const rawManifests = await loadRuntimeManifests(discovery);
  const { manifests, target } = prepareRuntimeManifests({
    rawManifests,
    runtimeId: args.runtimeId,
    pluginId: args.pluginId,
    ignoreUpstreams: args.ignoreUpstreams,
  });
  const loadedCache = await loadRuntimeCache({
    discovery,
    rawManifests,
    locale: args.locale,
  });
  const localTools = await loadLocalTools(discovery, manifests, args.store);
  return {
    discovery,
    rawManifests,
    manifests,
    target,
    loadedCache,
    localTools,
  };
}

export async function loadLocalTools(
  discovery: PluginDiscoveryResult,
  manifests: readonly RuntimeManifest[],
  store?: DataStore,
): Promise<readonly ToolModule[]> {
  const loaded: ToolModule[] = [];
  for (const manifest of manifests) {
    for (const localPath of manifest.tools?.local ?? []) {
      const fullPath = path.resolve(discovery.rootPath, localPath);
      const rel = path.relative(discovery.rootPath, fullPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`tools.local path escapes plugin root: ${localPath}`);
      }
      if (!fs.existsSync(fullPath)) {
        throw new Error(`tools.local file not found: ${fullPath}`);
      }
      const mod = await import(pathToFileURL(fullPath).href);
      const exported = mod.default ?? Object.values(mod)[0];
      const candidate =
        typeof exported === "function"
          ? exported({
              tool,
              z,
              shortId,
              shortIdBatch,
              withPendingProposals,
              store,
            })
          : exported;
      if (
        candidate &&
        typeof candidate === "object" &&
        (candidate as { _type?: unknown })._type === "covel-tool"
      ) {
        loaded.push(candidate as ToolModule);
      }
    }
  }
  return loaded;
}
