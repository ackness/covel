import type {
  LoadedPlugin,
  LoadedRuntime,
  PluginInfo,
  PluginRegistry,
  V1RuntimeRegistry,
  V1ToolRegistry,
  RegisteredToolV1,
  PluginRegistries,
} from "./types.js";

// ── Plugin Registry ─────────────────────────────────────────────────

export function createPluginRegistry(): PluginRegistry & {
  add(plugin: LoadedPlugin): void;
  remove(pluginId: string): void;
  swap(pluginId: string, next: LoadedPlugin): LoadedPlugin | undefined;
  getLoaded(pluginId: string): LoadedPlugin | undefined;
  enabledSessions: Map<string, Set<string>>;
} {
  const plugins = new Map<string, LoadedPlugin>();
  const enabledSessions = new Map<string, Set<string>>();

  function add(plugin: LoadedPlugin): void {
    plugins.set(plugin.manifest.id, plugin);
  }

  function remove(pluginId: string): void {
    plugins.delete(pluginId);
    enabledSessions.delete(pluginId);
  }

  function swap(pluginId: string, next: LoadedPlugin): LoadedPlugin | undefined {
    const previous = plugins.get(pluginId);
    plugins.set(pluginId, next);
    return previous;
  }

  function get(pluginId: string): LoadedPlugin | undefined {
    return plugins.get(pluginId);
  }

  function getLoaded(pluginId: string): LoadedPlugin | undefined {
    return plugins.get(pluginId);
  }

  function has(pluginId: string): boolean {
    return plugins.has(pluginId);
  }

  function list(): PluginInfo[] {
    return Array.from(plugins.values()).map((p) => ({
      id: p.manifest.id,
      pluginType: p.manifest.pluginType,
      displayName: p.manifest.displayName,
      version: p.manifest.version,
      runtimeIds: p.manifest.runtimeIds,
      generationId: p.generationId,
      enabled: true,
    }));
  }

  return { get, getLoaded, list, has, add, remove, swap, enabledSessions };
}

// ── Runtime Registry ────────────────────────────────────────────────

export function createRuntimeRegistry(): V1RuntimeRegistry & {
  register(pluginId: string, runtime: LoadedRuntime): void;
  removeByPlugin(pluginId: string): void;
} {
  const runtimes = new Map<string, LoadedRuntime>();

  function qid(pluginId: string, runtimeId: string): string {
    return `${pluginId}:${runtimeId}`;
  }

  function register(pluginId: string, runtime: LoadedRuntime): void {
    runtimes.set(qid(pluginId, runtime.manifest.id), runtime);
  }

  function removeByPlugin(pluginId: string): void {
    for (const [key, rt] of runtimes) {
      if (rt.pluginId === pluginId) runtimes.delete(key);
    }
  }

  function get(pluginId: string, runtimeId: string): LoadedRuntime | undefined {
    return runtimes.get(qid(pluginId, runtimeId));
  }

  function listByPlugin(pluginId: string): LoadedRuntime[] {
    return Array.from(runtimes.values()).filter((r) => r.pluginId === pluginId);
  }

  function listAll(): LoadedRuntime[] {
    return Array.from(runtimes.values());
  }

  return { get, listByPlugin, listAll, register, removeByPlugin };
}

// ── Tool Registry ───────────────────────────────────────────────────

export function createToolRegistry(): V1ToolRegistry {
  const tools = new Map<string, RegisteredToolV1>();
  const runtimeImports = new Map<string, Set<string>>();

  function runtimeKey(pluginId: string, runtimeId: string): string {
    return `${pluginId}:${runtimeId}`;
  }

  function register(definition: RegisteredToolV1): void {
    tools.set(definition.qualifiedId, definition);
  }

  function unregisterByPlugin(pluginId: string): void {
    for (const [key, tool] of tools) {
      if (tool.pluginId === pluginId) tools.delete(key);
    }
    for (const key of Array.from(runtimeImports.keys())) {
      if (key.startsWith(`${pluginId}:`)) runtimeImports.delete(key);
    }
  }

  function setRuntimeImports(pluginId: string, runtimeId: string, imports: string[]): void {
    runtimeImports.set(runtimeKey(pluginId, runtimeId), new Set(imports));
  }

  function resolveForRuntime(pluginId: string, runtimeId: string): RegisteredToolV1[] {
    const result: RegisteredToolV1[] = [];
    const allowedImports = runtimeImports.get(runtimeKey(pluginId, runtimeId)) ?? new Set<string>();
    for (const tool of tools.values()) {
      // Local tools for this runtime
      if (tool.pluginId === pluginId && tool.runtimeId === runtimeId) {
        result.push(tool);
        continue;
      }
      // Imported tools (exported by other plugins)
      if (tool.exported && tool.pluginId !== pluginId && allowedImports.has(tool.qualifiedId)) {
        result.push(tool);
      }
    }
    return result;
  }

  function getQualified(id: string): RegisteredToolV1 | undefined {
    return tools.get(id);
  }

  return { register, unregisterByPlugin, resolveForRuntime, getQualified, setRuntimeImports } as V1ToolRegistry & {
    setRuntimeImports(pluginId: string, runtimeId: string, imports: string[]): void;
  };
}

// ── Combined Registries ─────────────────────────────────────────────

export function createPluginRegistries(): PluginRegistries & {
  pluginStore: ReturnType<typeof createPluginRegistry>;
  runtimeStore: ReturnType<typeof createRuntimeRegistry>;
  toolStore: ReturnType<typeof createToolRegistry>;
} {
  const pluginStore = createPluginRegistry();
  const runtimeStore = createRuntimeRegistry();
  const toolStore = createToolRegistry();

  return {
    plugins: pluginStore,
    runtimes: runtimeStore,
    tools: toolStore,
    pluginStore,
    runtimeStore,
    toolStore,
  };
}
