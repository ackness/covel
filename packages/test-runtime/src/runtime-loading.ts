import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeManifest } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import type { PluginAPI } from "@covel/runtime";
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
  /** Tools the plugin's `entry` module registered, if it declares one. */
  readonly entryTools: readonly ToolModule[];
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
  const entryTools = await loadEntryTools(discovery, manifests, args.store);
  return {
    discovery,
    rawManifests,
    manifests,
    target,
    loadedCache,
    entryTools,
  };
}

/**
 * Run the plugin's `entry` module and collect the tools it registers.
 *
 * The harness only needs the tool surface, so the `PluginAPI` it passes
 * implements `registerTool` and no-ops the rest: hooks, RPC actions and media
 * wires are server-bootstrap concerns that a single-runtime harness turn never
 * reaches. An entry that registers one of those still runs to completion — it
 * just has no observable effect here.
 */
export async function loadEntryTools(
  discovery: PluginDiscoveryResult,
  manifests: readonly RuntimeManifest[],
  store?: DataStore,
): Promise<readonly ToolModule[]> {
  const entryPath = manifests.find((m) => m.entry)?.entry;
  if (!entryPath) return [];

  const fullPath = path.resolve(discovery.rootPath, entryPath);
  const rel = path.relative(discovery.rootPath, fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`entry path escapes plugin root: ${entryPath}`);
  }
  if (!fs.existsSync(fullPath)) {
    throw new Error(`entry file not found: ${fullPath}`);
  }

  const registered: ToolModule[] = [];
  const covel = {
    pluginId: discovery.id,
    toolkit: {
      tool,
      z,
      shortId,
      shortIdBatch,
      withPendingProposals,
      ...(store ? { store } : {}),
    },
    http: { fetchWithRetry, validateBaseUrl: validateBaseUrlForPlugin },
    registerTool(toolModule: ToolModule) {
      registered.push(toolModule);
    },
    on() {},
    registerRpc() {},
    registerWires() {},
  } as unknown as PluginAPI;

  const mod = await import(pathToFileURL(fullPath).href);
  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new Error(`entry module must default-export a function: ${fullPath}`);
  }
  await factory(covel);
  return registered;
}
