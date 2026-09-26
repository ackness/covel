import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeManifest } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import {
  PluginEntryScope,
  PluginServiceRegistry,
  type PluginAPI,
} from "@covel/runtime";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadPluginEntryDefinition,
  pluginDeclarations,
  resolvePluginRuntimeManifest,
  type PluginDefinition,
  loadRuntime,
  type LoadedRuntime,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import {
  ToolRegistry,
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
  readonly pluginIds: readonly string[];
  readonly discoveries: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly loadedCache: Map<string, LoadedRuntime>;
  /** Tools registered by the selected packages' entry modules. */
  readonly entryTools: readonly { pluginId: string; tool: ToolModule }[];
  readonly services: PluginServiceRegistry;
  close(): Promise<void>;
}

export function expandPath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

export function defaultPluginsDir(): string {
  const pluginsDir = process.env.COVEL_USER_PLUGINS_DIR?.trim();
  const covelHome = process.env.COVEL_HOME?.trim();
  return expandPath(
    pluginsDir || path.join(covelHome || "~/.covel", "plugins"),
  );
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
  const definition = await loadPluginDefinition(discovery);
  return definition.manifests.map(({ manifest }) =>
    resolvePluginRuntimeManifest(definition, manifest),
  );
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
  readonly definition: PluginDefinition;
  readonly locale: string;
}): Promise<Map<string, LoadedRuntime>> {
  const loadedCache = new Map<string, LoadedRuntime>();
  for (const manifest of args.rawManifests) {
    const loaded = await loadRuntime(
      args.discovery,
      manifest.name,
      args.locale,
      args.definition,
    );
    loadedCache.set(manifest.name, {
      ...loaded,
      manifest: resolvePluginRuntimeManifest(args.definition, loaded.manifest),
    });
  }
  return loadedCache;
}

export async function loadRuntimeBundle(args: {
  readonly pluginsDir: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly locale: string;
  readonly ignoreUpstreams?: boolean;
  readonly withPlugins?: readonly string[];
  readonly store?: Pick<DataStore, "getSession">;
}): Promise<RuntimeLoadResult> {
  const pluginIds = [args.pluginId];
  for (const id of args.withPlugins ?? []) {
    if (
      typeof id !== "string" ||
      !id.trim() ||
      id !== id.trim() ||
      id.includes("/")
    ) {
      throw new Error(`invalid support plugin id: ${String(id)}`);
    }
    if (!pluginIds.includes(id)) pluginIds.push(id);
  }
  // Resolve every selected package and the target before any entry factory runs.
  const discoveries = new Map<string, PluginDiscoveryResult>();
  const definitions = new Map<string, PluginDefinition>();
  for (const id of pluginIds) {
    const discovery = await discoverPlugin(args.pluginsDir, id);
    discoveries.set(id, discovery);
    definitions.set(id, await loadPluginDefinition(discovery));
  }
  const discovery = discoveries.get(args.pluginId)!;
  const targetDefinition = definitions.get(args.pluginId)!;
  const targetManifests = targetDefinition.manifests.map(({ manifest }) =>
    resolvePluginRuntimeManifest(targetDefinition, manifest),
  );
  if (!targetManifests.some((manifest) => manifest.name === args.runtimeId)) {
    throw new Error(
      `runtime "${args.runtimeId}" not found in plugin "${args.pluginId}"`,
    );
  }
  const rawManifests = pluginIds.flatMap((id) =>
    id === args.pluginId
      ? targetManifests
      : definitions
          .get(id)!
          .manifests.map(({ manifest }) =>
            resolvePluginRuntimeManifest(definitions.get(id)!, manifest),
          ),
  );
  const { manifests, target } = prepareRuntimeManifests({
    rawManifests,
    runtimeId: args.runtimeId,
    pluginId: args.pluginId,
    ignoreUpstreams: args.ignoreUpstreams,
  });
  const loadedCache = new Map<string, LoadedRuntime>();
  for (const id of pluginIds) {
    const definition = definitions.get(id)!;
    const cache = await loadRuntimeCache({
      discovery: discoveries.get(id)!,
      definition,
      rawManifests: definition.manifests.map(({ manifest }) =>
        resolvePluginRuntimeManifest(definition, manifest),
      ),
      locale: args.locale,
    });
    for (const [name, loaded] of cache) loadedCache.set(name, loaded);
  }
  const selected = new Set(pluginIds);
  const sessionPlugins = async (sessionId: string) => {
    if (!args.store) return pluginIds;
    const session = await args.store.getSession(sessionId);
    if (!session) throw new Error(`session "${sessionId}" not found`);
    return session.activePlugins.filter((id) => selected.has(id));
  };
  const services = new PluginServiceRegistry({
    list: sessionPlugins,
    ensure: async (sessionId, pluginId) => {
      if (
        !selected.has(pluginId) ||
        !(await sessionPlugins(sessionId)).includes(pluginId)
      ) {
        throw new Error(
          `plugin "${pluginId}" is not active in session "${sessionId}"`,
        );
      }
    },
  });
  const entries: Awaited<ReturnType<typeof loadEntryTools>>[] = [];
  const entryTools: { pluginId: string; tool: ToolModule }[] = [];
  const close = async () => {
    const errors: unknown[] = [];
    for (const entry of [...entries].reverse()) {
      try {
        await entry.close();
      } catch (error) {
        errors.push(
          ...(error instanceof AggregateError ? error.errors : [error]),
        );
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Failed to close plugin entries");
  };
  try {
    for (const id of pluginIds) {
      const entry = await loadEntryTools(
        discoveries.get(id)!,
        definitions.get(id)!,
        services,
      );
      entries.push(entry);
      entryTools.push(...entry.tools.map((tool) => ({ pluginId: id, tool })));
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [
          error,
          ...(cleanupError instanceof AggregateError
            ? cleanupError.errors
            : [cleanupError]),
        ],
        error instanceof Error
          ? error.message
          : "Plugin entry activation failed",
        { cause: error },
      );
    }
    throw error;
  }
  return {
    discovery,
    rawManifests,
    manifests,
    target,
    pluginIds,
    discoveries,
    loadedCache,
    entryTools,
    services,
    close,
  };
}

/**
 * Run the plugin's `entry` module and collect the tools it registers.
 *
 * The harness publishes tools and services after all entry factories succeed.
 * Hooks, RPC actions and media wires are server-bootstrap concerns that a
 * single-runtime harness turn never
 * reaches. An entry that registers one of those still runs to completion — it
 * just has no observable effect here.
 */
export async function loadEntryTools(
  discovery: PluginDiscoveryResult,
  definition: PluginDefinition,
  services?: PluginServiceRegistry,
): Promise<{ tools: readonly ToolModule[]; close(): Promise<void> }> {
  const { entryPaths } = await loadPluginEntryDefinition(
    discovery,
    pluginDeclarations(definition),
  );
  if (entryPaths.length === 0) return { tools: [], close: async () => {} };

  const tools = new ToolRegistry();
  const scope = new PluginEntryScope();
  const covel: PluginAPI = {
    pluginId: discovery.id,
    signal: scope.signal,
    onDispose(callback) {
      scope.onDispose(callback);
    },
    toolkit: {
      tool,
      z,
      shortId,
      shortIdBatch,
      withPendingProposals,
    },
    http: { fetchWithRetry, validateBaseUrl: validateBaseUrlForPlugin },
    registerTool(toolModule: ToolModule) {
      scope.stage(() => {
        scope.track(tools.registerPlugin(discovery.id, toolModule));
      });
    },
    registerService(definition) {
      if (!services) throw new Error("Plugin service registry is unavailable");
      scope.stage(() => {
        scope.track(services.register(discovery.id, definition));
      });
    },
    on() {},
    registerRpc() {},
    registerFormValidator() {},
    registerWires() {},
  };

  try {
    const realRoot = await fs.promises.realpath(discovery.rootPath);
    for (const entryPath of entryPaths) {
      const fullPath = path.resolve(discovery.rootPath, entryPath);
      const rel = path.relative(discovery.rootPath, fullPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`entry path escapes plugin root: ${entryPath}`);
      }
      if (!fs.existsSync(fullPath)) {
        throw new Error(`entry file not found: ${fullPath}`);
      }
      const realPath = await fs.promises.realpath(fullPath);
      const realRel = path.relative(realRoot, realPath);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        throw new Error(`entry path escapes plugin root: ${entryPath}`);
      }

      const mod = await import(pathToFileURL(realPath).href);
      const factory = mod.default;
      if (typeof factory !== "function") {
        throw new Error(
          `entry module must default-export a function: ${fullPath}`,
        );
      }
      await factory(covel);
    }
    // Match production publication: invalid declarations fail the activation
    // after factories return, even if plugin code catches registration errors.
    scope.commit();
  } catch (error) {
    scope.abort(error);
    try {
      await scope.dispose(error);
    } catch (cleanupError) {
      throw new AggregateError(
        [
          error,
          ...(cleanupError instanceof AggregateError
            ? cleanupError.errors
            : [cleanupError]),
        ],
        error instanceof Error
          ? error.message
          : "Plugin entry activation failed",
        { cause: error },
      );
    }
    throw error;
  }
  return {
    tools: [...(tools.pluginTools.get(discovery.id)?.values() ?? [])],
    close: () => scope.dispose(),
  };
}
