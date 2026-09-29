import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolModule, ToolSource } from "./types.js";

/** Reserved even when a host does not install an optional or virtual builtin. */
export const FRAMEWORK_TOOL_NAMES = [
  "render-ui",
  "create-form",
  "create-choices",
  "create-notification",
  "suspend",
  "runtime-done",
  "search-tools",
  "plugin-data-set",
  "plugin-data-set-batch",
  "plugin-data-get",
  "plugin-data-list",
  "emit-event",
  "create-character",
  "update-character",
  "sync-characters",
  "list-characters",
  "get-character",
  "get-character-schema",
  "memory-search",
] as const;

const reservedNames: ReadonlySet<string> = new Set(FRAMEWORK_TOOL_NAMES);

/** Tool names stay local to the calling plugin, including LLM-facing names. */
export class ToolRegistry {
  readonly builtinTools = new Map<string, ToolModule>();
  private readonly livePluginTools = new Map<string, Map<string, ToolModule>>();
  private readonly snapshots = new AsyncLocalStorage<
    Map<string, Map<string, ToolModule>>
  >();
  get pluginTools(): Map<string, Map<string, ToolModule>> {
    return this.snapshots.getStore() ?? this.livePluginTools;
  }
  withSnapshot<T>(fn: () => T): T {
    if (this.snapshots.getStore()) return fn();
    return this.snapshots.run(
      new Map(
        [...this.livePluginTools].map(([id, tools]) => [id, new Map(tools)]),
      ),
      fn,
    );
  }
  replacePlugin<T>(pluginId: string, publish: () => T): T {
    const previous = this.livePluginTools.get(pluginId);
    this.livePluginTools.delete(pluginId);
    try {
      return publish();
    } catch (error) {
      this.livePluginTools.delete(pluginId);
      if (previous) this.livePluginTools.set(pluginId, previous);
      throw error;
    }
  }

  registerBuiltin(module: ToolModule): void {
    if (!reservedNames.has(module.name)) {
      throw new Error(`Framework tool "${module.name}" must reserve its name`);
    }
    this.builtinTools.set(module.name, module);
  }

  registerPlugin(pluginId: string, module: ToolModule): () => void {
    if (
      !module ||
      module._type !== "covel-tool" ||
      typeof module.name !== "string" ||
      module.name.trim().length === 0 ||
      module.name !== module.name.trim() ||
      typeof module.description !== "string" ||
      typeof module.parametersSchema?.safeParse !== "function" ||
      !module.jsonSchema ||
      typeof module.jsonSchema !== "object" ||
      Array.isArray(module.jsonSchema) ||
      typeof module.execute !== "function"
    ) {
      throw new Error("expected a ToolModule built with covel.toolkit.tool()");
    }
    if (reservedNames.has(module.name)) {
      throw new Error(`tool "${module.name}" is reserved by the framework`);
    }
    let tools = this.livePluginTools.get(pluginId);
    if (tools?.has(module.name)) {
      throw new Error(
        `tool "${module.name}" is already registered by plugin "${pluginId}"`,
      );
    }
    if (!tools) {
      tools = new Map();
      this.livePluginTools.set(pluginId, tools);
    }
    const name = module.name;
    tools.set(name, module);
    const owned = tools;
    return () => {
      if (owned.get(name) !== module) return;
      owned.delete(name);
      if (owned.size === 0 && this.livePluginTools.get(pluginId) === owned) {
        this.livePluginTools.delete(pluginId);
      }
    };
  }

  find(name: string, pluginId: string): ToolModule | undefined {
    return (
      this.builtinTools.get(name) ?? this.pluginTools.get(pluginId)?.get(name)
    );
  }

  /** Called only after successful resolution by the executor. */
  source(name: string): ToolSource {
    return this.builtinTools.has(name) ? "builtin" : "local";
  }
}
