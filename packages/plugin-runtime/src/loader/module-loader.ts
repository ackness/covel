import { join } from "node:path";
import { access } from "node:fs/promises";
import type {
  ContributionMap,
  PluginRegistrar,
  PluginServerModule,
  ToolHandler,
  HookHandler,
  ContextProvider,
  RuntimeHandler,
} from "../types.js";

/**
 * Create a sandboxed PluginRegistrar that collects contributions.
 */
function createRegistrar(): {
  registrar: PluginRegistrar;
  contributions: ContributionMap;
} {
  const contributions: ContributionMap = {
    tools: new Map(),
    hooks: new Map(),
    contextProviders: new Map(),
    runtimeHandlers: new Map(),
  };

  const registrar: PluginRegistrar = {
    addTool(id: string, handler: ToolHandler) {
      contributions.tools.set(id, handler);
    },
    addHook(id: string, handler: HookHandler) {
      contributions.hooks.set(id, handler);
    },
    addContextProvider(id: string, handler: ContextProvider) {
      contributions.contextProviders.set(id, handler);
    },
    addRuntimeHandler(runtimeId: string, handler: RuntimeHandler) {
      contributions.runtimeHandlers.set(runtimeId, handler);
    },
  };

  return { registrar, contributions };
}

/**
 * Load a plugin's server module and collect its contributions.
 *
 * Expects `server/index.ts` (or `.js`) in the plugin directory
 * with a default export function `register(registrar)`.
 *
 * Returns null if no server module exists.
 */
export async function loadPluginModule(
  pluginDir: string
): Promise<ContributionMap | null> {
  // Try .ts first (for dev), then .js (for built)
  const candidates = [
    join(pluginDir, "server", "index.ts"),
    join(pluginDir, "server", "index.js"),
  ];

  let modulePath: string | null = null;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      modulePath = candidate;
      break;
    } catch {
      // Not found, try next
    }
  }

  if (!modulePath) {
    return null;
  }

  const mod = (await import(modulePath)) as PluginServerModule;

  if (typeof mod.default !== "function") {
    throw new Error(
      `Plugin module at ${modulePath} must have a default export function.`
    );
  }

  const { registrar, contributions } = createRegistrar();
  await mod.default(registrar);
  return contributions;
}
