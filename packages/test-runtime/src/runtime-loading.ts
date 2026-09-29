import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeManifest } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import {
  PluginEntryScope,
  createHookPipeline,
  validatePluginHookRegistration,
  type HookPipeline,
  PluginExtensionHost,
  createExtensionRegistration,
  enforcePluginRegistrationContract,
  PluginServiceRegistry,
  type PluginAPI,
} from "@covel/runtime";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginDefinition,
  loadPluginEntryDefinition,
  loadPluginSummary,
  pluginDeclarations,
  resolvePluginRuntimeManifest,
  type PluginDefinition,
  loadRuntime,
  type LoadedRuntime,
  type PluginDiscoveryResult,
  type PluginRegistry,
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

export interface UnsupportedDebugCapability {
  readonly pluginId: string;
  readonly kind: "hook" | "rpc" | "form-validator" | "media-wire" | "extension";
  readonly name: string;
}

export interface RuntimeLoadResult {
  readonly hookPipeline: HookPipeline;
  readonly hookSettings: readonly {
    pluginId: string;
    userSettings?: RuntimeManifest["userSettings"];
  }[];
  readonly unsupportedCapabilities: readonly UnsupportedDebugCapability[];
  readonly discovery: PluginDiscoveryResult;
  readonly rawManifests: readonly RuntimeManifest[];
  readonly manifests: readonly RuntimeManifest[];
  readonly target: RuntimeManifest;
  readonly pluginIds: readonly string[];
  readonly discoveries: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly registry: PluginRegistry;
  readonly loadedCache: Map<string, LoadedRuntime>;
  /** Tools registered by the selected packages' entry modules. */
  readonly entryTools: readonly { pluginId: string; tool: ToolModule }[];
  readonly services: PluginServiceRegistry;
  readonly extensions: PluginExtensionHost;
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
  readonly contracts?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
}): Promise<Map<string, LoadedRuntime>> {
  const loadedCache = new Map<string, LoadedRuntime>();
  for (const manifest of args.rawManifests) {
    const loaded = await loadRuntime(
      args.discovery,
      manifest.name,
      args.locale,
      args.definition,
      args.contracts,
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
  const registry = createPluginRegistry();
  for (const id of pluginIds) {
    const discovery = await discoverPlugin(args.pluginsDir, id);
    const definition = await loadPluginDefinition(discovery);
    discoveries.set(id, discovery);
    definitions.set(id, definition);
    registry.register({
      id,
      summary: await loadPluginSummary(discovery, args.locale, definition),
      packageManifest: definition.packageManifest,
      manifests: definition.manifests,
      loadedRuntimes: new Map(),
      status: "registered",
    });
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
      contracts: Object.fromEntries(
        [...definitions.values()].flatMap((d) =>
          Object.entries(d.packageManifest?.contractSchemas ?? {}),
        ),
      ),
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
  const extensions = new PluginExtensionHost(services);
  const hookPipeline = createHookPipeline();
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
        extensions,
        hookPipeline,
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
    hookPipeline,
    hookSettings: [...definitions].map(([pluginId, definition]) => ({
      pluginId,
      userSettings: definition.packageManifest?.manifest.userSettings,
    })),
    unsupportedCapabilities: entries.flatMap(
      (entry) => entry.unsupportedCapabilities,
    ),
    discovery,
    rawManifests,
    manifests,
    target,
    pluginIds,
    discoveries,
    registry,
    loadedCache,
    entryTools,
    services,
    extensions,
    close,
  };
}

/**
 * Run the plugin's `entry` module and collect the tools it registers.
 *
 * The harness publishes tools and services after all entry factories succeed.
 * Turn hooks use the runtime pipeline. Registrations requiring a session
 * lifecycle or HTTP/UI host are reported explicitly as unsupported.
 */
export async function loadEntryTools(
  discovery: PluginDiscoveryResult,
  definition: PluginDefinition,
  services?: PluginServiceRegistry,
  extensions?: PluginExtensionHost,
  hookPipeline?: HookPipeline,
): Promise<{
  tools: readonly ToolModule[];
  unsupportedCapabilities: readonly UnsupportedDebugCapability[];
  close(): Promise<void>;
}> {
  const {
    entryPaths,
    extensions: declarations,
    staticPromptSegments,
    staticPromptVariants,
    contributions,
  } = await loadPluginEntryDefinition(
    discovery,
    pluginDeclarations(definition),
  );
  if (
    entryPaths.length === 0 &&
    declarations.length === 0 &&
    staticPromptSegments.length === 0
  )
    return { tools: [], unsupportedCapabilities: [], close: async () => {} };

  const tools = new ToolRegistry();
  // Prompt/world/history-transform providers run in executeTurn. These three
  // built-in points are driven only by the server's UI, HTTP or compaction host.
  const hostOnlyPoints = new Set([
    "history.compact@1",
    "ui.slot@1",
    "media.image-flow@1",
  ]);
  const unsupportedCapabilities: UnsupportedDebugCapability[] = declarations
    .filter((declaration) => hostOnlyPoints.has(declaration.point))
    .map((declaration) => ({
      pluginId: discovery.id,
      kind: "extension",
      name: `${declaration.point}/${declaration.id}`,
    }));
  let hookSeq = 0;
  const scope = new PluginEntryScope();
  const registration = createExtensionRegistration(
    extensions,
    discovery.id,
    declarations,
    scope,
    undefined,
    staticPromptSegments,
    staticPromptVariants,
  );
  const covel: PluginAPI = {
    pluginId: discovery.id,
    provideExtension: registration.provideExtension,
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
        scope.track(
          tools.registerPlugin(discovery.id, {
            ...toolModule,
            execute: (input, context) =>
              scope.invoke(() => toolModule.execute(input, context)),
          }),
        );
      });
    },
    registerService(definition) {
      if (!services) throw new Error("Plugin service registry is unavailable");
      scope.stage(() => {
        scope.track(
          services.register(discovery.id, {
            ...definition,
            handler: (input, context) =>
              scope.invoke(() => definition.handler(input, context)),
          }),
        );
      });
    },
    on(event, handler, options) {
      scope.stage(() => {
        validatePluginHookRegistration(event, handler, options);
        // No session lifecycle or history-compactor service runs in this harness.
        if (
          !hookPipeline ||
          [
            "SessionStart",
            "SessionEnd",
            "PreCompaction",
            "PostCompaction",
          ].includes(event)
        ) {
          unsupportedCapabilities.push({
            pluginId: discovery.id,
            kind: "hook",
            name: event,
          });
          return;
        }
        const id = `${discovery.id}:${event}:${++hookSeq}`;
        scope.track(
          hookPipeline.register({
            id,
            event,
            pluginId: discovery.id,
            handler: (context, payload) =>
              scope.invoke(() => handler(context, payload)),
            ...(options?.match ? { match: options.match } : {}),
            ...(options?.timeoutMs !== undefined
              ? { timeoutMs: options.timeoutMs }
              : {}),
            ...(options?.enforce ? { enforce: options.enforce } : {}),
          }),
        );
      });
    },
    registerRpc(name) {
      scope.stage(() => {
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "rpc",
          name,
        });
      });
    },
    registerFormValidator(name) {
      scope.stage(() => {
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "form-validator",
          name,
        });
      });
    },
    registerWires() {
      scope.stage(() => {
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "media-wire",
          name: "media wires",
        });
      });
    },
  };

  const checked = enforcePluginRegistrationContract(covel, contributions);
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
      await factory(checked.api);
    }
    // Match production publication: invalid declarations fail the activation
    // after factories return, even if plugin code catches registration errors.
    checked.validate();
    registration.validate();
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
    unsupportedCapabilities,
    tools: [...(tools.pluginTools.get(discovery.id)?.values() ?? [])],
    close: () => scope.dispose(),
  };
}
