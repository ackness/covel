import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FRAMEWORK_PLUGIN_ID,
  rpcActionNameSchema,
  type RuntimeManifest,
} from "@covel/shared";
import {
  APP_EVENT_NAMES,
  configFlowIdSchema,
  providerSourceIdSchema,
  scheduledTaskIdSchema,
} from "@covel/shared/platform";
import type { DataStore } from "@covel/store";
import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import {
  PluginEntryScope,
  createHookPipeline,
  draftHoldingHooks,
  draftHoldingKey,
  enforceHttpPermissions,
  validatePluginHookRegistration,
  type HookPipeline,
  PluginExtensionHost,
  createExtensionRegistration,
  enforcePluginRegistrationContract,
  PluginServiceRegistry,
  type PluginAPI,
} from "@covel/runtime";
import {
  isPathInside,
  createPluginRegistry,
  discoverPlugins,
  loadPluginDefinition,
  loadPluginEntryDefinition,
  loadPluginSummary,
  resolvePluginRuntimeManifest,
  type PluginDefinition,
  loadRuntime,
  type LoadedRuntime,
  type PluginDiscoveryResult,
  type PluginRegistry,
  provideHostModules,
} from "@covel/plugin-loader";
import {
  ToolRegistry,
  shortId,
  shortIdBatch,
  tool,
  withModelView,
  ToolError,
  withPendingProposals,
  z,
  type ToolModule,
} from "@covel/tools";

export interface UnsupportedDebugCapability {
  readonly pluginId: string;
  readonly kind:
    | "hook"
    | "rpc"
    | "app-action"
    | "flow"
    | "app-event"
    | "schedule"
    | "form-validator"
    | "media-wire"
    | "provider-source"
    | "extension";
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

async function loadRuntimeCache(args: {
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
  const services = new PluginServiceRegistry(
    {
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
    },
    (pluginId) => definitions.get(pluginId)?.messages,
  );
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

const rpcOptionsSchema = z
  .object({
    description: z.string().optional(),
    trustLevel: z.enum(["builtin", "community"]).optional(),
  })
  .strict();

function hasWireShape(value: unknown, method: string): value is { id: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string" &&
    (value as Record<string, unknown>).id !== "" &&
    typeof (value as Record<string, unknown>)[method] === "function"
  );
}

function withCallSignal(
  http: PluginAPI["http"],
  signal: AbortSignal,
): PluginAPI["http"] {
  return {
    validateBaseUrl: (url) => http.validateBaseUrl(url),
    fetchWithRetry: (input, init) =>
      http.fetchWithRetry(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      }),
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
    entryPath,
    extensions: declarations,
    staticPromptSegments,
    staticPromptVariants,
    contributions,
    httpPermissions,
  } = await loadPluginEntryDefinition(
    discovery,
    definition.packageManifest,
    definition.manifests,
  );
  if (
    !entryPath &&
    declarations.length === 0 &&
    staticPromptSegments.length === 0
  )
    return { tools: [], unsupportedCapabilities: [], close: async () => {} };

  const tools = new ToolRegistry();
  // Prompt/world/history-transform providers run in executeTurn. These
  // built-in points are driven only by the server's UI, HTTP, channel, or compaction host.
  const hostOnlyPoints = new Set([
    "channel.bridge@1",
    "history.compact@2",
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
  const heldHooks = draftHoldingHooks(contributions);
  const registeredRpcActions = new Set<string>();
  const registeredAppActions = new Set<string>();
  const registeredConfigFlows = new Set<string>();
  const registeredAppEvents = new Set<string>();
  const registeredScheduledTasks = new Set<string>();
  const registeredFormValidators = new Set<string>();
  const registeredWires = new Set<string>();
  const registeredProviderSources = new Set<string>();
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
  const http = enforceHttpPermissions(
    { fetchWithRetry, validateBaseUrl: validateBaseUrlForPlugin },
    { httpPermissions, runtimeId: discovery.id },
  );
  // A service or extension provider's code sends its own requests, so it
  // reaches what its own package declares, whoever calls it.
  const ownUtils = <
    C extends { utils?: unknown; http?: unknown; signal: AbortSignal },
  >(
    context: C,
  ): C => {
    if (!context.utils && !context.http) return context;
    const scopedHttp = withCallSignal(http, context.signal);
    return {
      ...context,
      ...(context.utils ? { utils: scopedHttp } : {}),
      ...(context.http ? { http: scopedHttp } : {}),
    };
  };
  const covel: PluginAPI = {
    pluginId: discovery.id,
    provideExtension(point, id, definition) {
      registration.provideExtension(
        point,
        id,
        definition && typeof definition.handler === "function"
          ? {
              ...definition,
              handler: (input, context) =>
                definition.handler(input, ownUtils(context)),
            }
          : definition,
      );
    },
    signal: scope.signal,
    onDispose(callback) {
      scope.onDispose(callback);
    },
    toolkit: {
      tool,
      z,
      shortId,
      shortIdBatch,
      withModelView,
      ToolError,
      withPendingProposals,
    },
    http,
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
        // The registry hands a write service its write context; the union's
        // handler cannot be called with either context directly.
        const handler = definition.handler as (
          input: unknown,
          context: Parameters<typeof ownUtils>[0],
        ) => unknown;
        scope.track(
          services.register(discovery.id, {
            ...definition,
            ...(typeof handler === "function"
              ? {
                  handler: (input, context) =>
                    scope.invoke(() => handler(input, ownUtils(context))),
                }
              : {}),
          } as typeof definition),
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
            ...(heldHooks.has(draftHoldingKey(event, options?.enforce))
              ? { holdsDrafts: true }
              : {}),
          }),
        );
      });
    },
    registerRpc(action, handler, options) {
      scope.stage(() => {
        const parsedOptions = rpcOptionsSchema.safeParse(
          options === undefined ? {} : options,
        );
        if (!parsedOptions.success) {
          throw new Error(
            `registerRpc: ${parsedOptions.error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "options"}: ${issue.message}`,
              )
              .join("; ")}`,
          );
        }
        if (
          typeof action !== "string" ||
          !action.trim() ||
          typeof handler !== "function"
        ) {
          throw new Error(
            "registerRpc: expected a non-empty action name and a handler function",
          );
        }
        const parsedName = rpcActionNameSchema.safeParse(action);
        if (!parsedName.success) {
          throw new Error(
            `registerRpc: ${parsedName.error.issues
              .map((issue) => issue.message)
              .join("; ")}`,
          );
        }
        if (discovery.id === FRAMEWORK_PLUGIN_ID) {
          throw new Error(
            `[plugin-rpc] "${FRAMEWORK_PLUGIN_ID}" is reserved for framework actions`,
          );
        }
        if (registeredRpcActions.has(action)) {
          throw new Error(
            `registerRpc: action "${action}" is already registered in this plugin`,
          );
        }
        registeredRpcActions.add(action);
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "rpc",
          name: action,
        });
      });
    },
    registerAppAction(action, handler) {
      scope.stage(() => {
        if (
          typeof action !== "string" ||
          !action.trim() ||
          typeof handler !== "function"
        ) {
          throw new Error(
            "registerAppAction: expected a non-empty action name and a handler function",
          );
        }
        const parsedName = rpcActionNameSchema.safeParse(action);
        if (!parsedName.success) {
          throw new Error(
            `registerAppAction: ${parsedName.error.issues
              .map((issue) => issue.message)
              .join("; ")}`,
          );
        }
        if (registeredAppActions.has(action)) {
          throw new Error(
            `registerAppAction: action "${action}" is already registered in this plugin`,
          );
        }
        registeredAppActions.add(action);
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "app-action",
          name: action,
        });
      });
    },
    registerConfigFlow(flowId, definition) {
      scope.stage(() => {
        if (
          typeof flowId !== "string" ||
          !flowId.trim() ||
          !definition ||
          typeof definition.start !== "function" ||
          typeof definition.step !== "function"
        ) {
          throw new Error(
            "registerConfigFlow: expected a flowId and { start, step } handlers",
          );
        }
        const parsedId = configFlowIdSchema.safeParse(flowId);
        if (!parsedId.success) {
          throw new Error(
            `registerConfigFlow: ${parsedId.error.issues
              .map((issue) => issue.message)
              .join("; ")}`,
          );
        }
        if (registeredConfigFlows.has(flowId)) {
          throw new Error(
            `registerConfigFlow: flow "${flowId}" is already registered in this plugin`,
          );
        }
        registeredConfigFlows.add(flowId);
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "flow",
          name: flowId,
        });
      });
    },
    onAppEvent(event, handler) {
      scope.stage(() => {
        if (
          typeof event !== "string" ||
          !(APP_EVENT_NAMES as readonly string[]).includes(event) ||
          typeof handler !== "function"
        ) {
          throw new Error(
            "onAppEvent: expected a valid AppEvent name and handler function",
          );
        }
        registeredAppEvents.add(event);
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "app-event",
          name: event,
        });
      });
    },
    registerScheduledTask(taskId, handler) {
      scope.stage(() => {
        if (
          typeof taskId !== "string" ||
          !taskId.trim() ||
          typeof handler !== "function"
        ) {
          throw new Error(
            "registerScheduledTask: expected a taskId and handler function",
          );
        }
        const parsedId = scheduledTaskIdSchema.safeParse(taskId);
        if (!parsedId.success) {
          throw new Error(
            `registerScheduledTask: ${parsedId.error.issues
              .map((issue) => issue.message)
              .join("; ")}`,
          );
        }
        if (registeredScheduledTasks.has(taskId)) {
          throw new Error(
            `registerScheduledTask: task "${taskId}" is already registered in this plugin`,
          );
        }
        registeredScheduledTasks.add(taskId);
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "schedule",
          name: taskId,
        });
      });
    },
    registerFormValidator(name, validator) {
      scope.stage(() => {
        if (
          typeof name !== "string" ||
          !name.trim() ||
          typeof validator !== "function"
        ) {
          throw new Error(
            "registerFormValidator: expected a name and validator function",
          );
        }
        if (registeredFormValidators.has(name)) {
          throw new Error(`Duplicate form validator: ${discovery.id}::${name}`);
        }
        registeredFormValidators.add(name);
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "form-validator",
          name,
        });
      });
    },
    registerWires(wires) {
      scope.stage(() => {
        if (!wires || typeof wires !== "object" || Array.isArray(wires)) {
          throw new Error(
            "registerWires: expected { image?, speech?, transcription?, music?, text? }",
          );
        }
        const claimWire = (kind: string, wireId: string) => {
          const namespacedId = `${discovery.id}/${wireId}`;
          const key = `${kind}:${namespacedId}`;
          if (registeredWires.has(key)) {
            throw new Error(
              `registerWires: wire "${namespacedId}" is already registered`,
            );
          }
          registeredWires.add(key);
        };
        if (wires.text !== undefined && !Array.isArray(wires.text)) {
          throw new Error("registerWires: text wires must be an array");
        }
        for (const wire of wires.text ?? []) {
          const candidate: unknown = wire;
          if (
            !hasWireShape(candidate, "generateText") ||
            typeof Reflect.get(candidate, "streamText") !== "function"
          ) {
            throw new Error(
              "registerWires: expected { id: string, generateText: function, streamText: function }",
            );
          }
          claimWire("text", candidate.id);
        }
        const groups: ReadonlyArray<{
          readonly kind: string;
          readonly wires: unknown;
          readonly method: string;
        }> = [
          { kind: "image", wires: wires.image, method: "generate" },
          { kind: "speech", wires: wires.speech, method: "synthesize" },
          {
            kind: "transcription",
            wires: wires.transcription,
            method: "transcribe",
          },
          { kind: "music", wires: wires.music, method: "compose" },
        ];
        for (const group of groups) {
          if (group.wires !== undefined && !Array.isArray(group.wires)) {
            throw new Error(
              `registerWires: ${group.method} wires must be an array`,
            );
          }
          for (const wire of (group.wires as readonly unknown[] | undefined) ??
            []) {
            if (!hasWireShape(wire, group.method)) {
              throw new Error(
                `registerWires: expected { id: string, ${group.method}: function }`,
              );
            }
            claimWire(group.kind, wire.id);
          }
        }
        unsupportedCapabilities.push({
          pluginId: discovery.id,
          kind: "media-wire",
          name: "media wires",
        });
      });
    },
    registerProviderSources(sources) {
      scope.stage(() => {
        if (!Array.isArray(sources)) {
          throw new Error("registerProviderSources: expected an array");
        }
        for (const source of sources) {
          if (
            !source ||
            typeof source !== "object" ||
            typeof source.id !== "string" ||
            !source.id.trim() ||
            typeof source.resolve !== "function"
          ) {
            throw new Error(
              "registerProviderSources: expected { id: string, resolve: function }",
            );
          }
          const parsedId = providerSourceIdSchema.safeParse(source.id);
          if (!parsedId.success) {
            throw new Error(
              `registerProviderSources: ${parsedId.error.issues
                .map((issue) => issue.message)
                .join("; ")}`,
            );
          }
          if (registeredProviderSources.has(source.id)) {
            throw new Error(
              `registerProviderSources: source "${source.id}" is already registered in this plugin`,
            );
          }
          registeredProviderSources.add(source.id);
          unsupportedCapabilities.push({
            pluginId: discovery.id,
            kind: "provider-source",
            name: source.id,
          });
        }
      });
    },
  };

  const checked = enforcePluginRegistrationContract(covel, contributions);
  try {
    const realRoot = await fs.promises.realpath(discovery.rootPath);
    if (entryPath) {
      const fullPath = path.resolve(discovery.rootPath, entryPath);
      if (!isPathInside(discovery.rootPath, fullPath, { allowRoot: true })) {
        throw new Error(`entry path escapes plugin root: ${entryPath}`);
      }
      if (!fs.existsSync(fullPath)) {
        throw new Error(`entry file not found: ${fullPath}`);
      }
      const realPath = await fs.promises.realpath(fullPath);
      if (!isPathInside(realRoot, realPath, { allowRoot: true })) {
        throw new Error(`entry path escapes plugin root: ${entryPath}`);
      }

      provideHostModules(discovery.rootPath);
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
