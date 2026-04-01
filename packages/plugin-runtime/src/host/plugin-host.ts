import { join } from "node:path";
import { access } from "node:fs/promises";
import { scanPluginDirectory } from "../loader/fs-scanner.js";
import { loadPluginModule } from "../loader/module-loader.js";
import { createPluginRegistry, type PluginRegistry } from "../registry/plugin-registry.js";
import { createToolRegistry, type ToolRegistry } from "../registry/tool-registry.js";
import { createHookRegistry, type HookRegistry } from "../registry/hook-registry.js";
import { createRuntimeRegistry, type RuntimeRegistry } from "../registry/runtime-registry.js";
import { createCommandRegistry, type CommandRegistry } from "../command/command-registry.js";
import type { LoadedPlugin, RegisteredContextProvider, ContextProvider } from "../types.js";

export interface PluginHost {
  pluginRegistry: PluginRegistry;
  toolRegistry: ToolRegistry;
  hookRegistry: HookRegistry;
  runtimeRegistry: RuntimeRegistry;
  commandRegistry: CommandRegistry;
  contextProviders: Map<string, RegisteredContextProvider>;

  /** Scan, validate, load, and register all plugins from a directory. */
  loadFromDirectory(baseDir: string): Promise<LoadedPlugin[]>;
}

/**
 * Create the top-level plugin host that orchestrates:
 * scan → validate → load modules → register contributions.
 */
export function createPluginHost(): PluginHost {
  const pluginRegistry = createPluginRegistry();
  const toolRegistry = createToolRegistry();
  const hookRegistry = createHookRegistry();
  const runtimeRegistry = createRuntimeRegistry();
  const commandRegistry = createCommandRegistry();
  const contextProviders = new Map<string, RegisteredContextProvider>();

  async function loadFromDirectory(baseDir: string): Promise<LoadedPlugin[]> {
    const scanned = await scanPluginDirectory(baseDir);
    const loaded: LoadedPlugin[] = [];

    // Sort by loadingOrder for deterministic load sequence
    scanned.sort(
      (a, b) => (a.manifest.loadingOrder ?? 100) - (b.manifest.loadingOrder ?? 100)
    );

    for (const { dir, manifest } of scanned) {
      // Check dependency/conflict constraints
      const constraintErrors = pluginRegistry.validateConstraints(manifest);
      if (constraintErrors.length > 0) {
        console.warn(
          `[plugin-host] Skipping "${manifest.id}" due to constraint errors:\n` +
            constraintErrors.map((e) => `  - ${e}`).join("\n")
        );
        continue;
      }

      // Register the plugin
      const plugin = pluginRegistry.add(manifest, dir);

      // Register runtimes from manifest
      if (manifest.runtimes) {
        for (const spec of manifest.runtimes) {
          let instructionsPath: string | undefined;
          if (spec.instructionsRef) {
            const refPath = join(dir, spec.instructionsRef);
            try {
              await access(refPath);
              instructionsPath = refPath;
            } catch {
              // Instructions file not found, continue without it
            }
          } else {
            // Default: look for PLUGIN.md
            const defaultPath = join(dir, "PLUGIN.md");
            try {
              await access(defaultPath);
              instructionsPath = defaultPath;
            } catch {
              // No PLUGIN.md
            }
          }
          runtimeRegistry.register(manifest.id, spec, instructionsPath);
        }
      }

      // Load server module and register contributions
      const contributions = await loadPluginModule(dir);
      if (contributions) {
        // Register tools
        const toolDefs = manifest.tools ?? [];
        for (const [toolId, handler] of contributions.tools) {
          const def = toolDefs.find((d) => d.id === toolId);
          if (def) {
            toolRegistry.register(manifest.id, def, handler);
          } else {
            // Tool registered without manifest definition — register with minimal def
            toolRegistry.register(
              manifest.id,
              { id: toolId, kind: "query" },
              handler
            );
          }
        }

        // Register hooks
        const hookDefs = manifest.hooks ?? [];
        for (const [hookId, handler] of contributions.hooks) {
          const def = hookDefs.find((d) => d.id === hookId);
          if (def) {
            hookRegistry.register(
              manifest.id,
              def,
              handler,
              manifest.loadingOrder ?? 100
            );
          }
        }

        // Register context providers
        for (const [cpId, handler] of contributions.contextProviders) {
          const qid = `${manifest.id}:${cpId}`;
          contextProviders.set(qid, {
            pluginId: manifest.id,
            id: cpId,
            handler,
          });
        }

        // Register runtime handlers
        for (const [rtId, handler] of contributions.runtimeHandlers) {
          try {
            runtimeRegistry.setHandler(manifest.id, rtId, handler);
          } catch {
            // Runtime not registered in manifest, skip
          }
        }

        // Register commands
        for (const cmdReg of contributions.commands) {
          try {
            commandRegistry.register({
              name: cmdReg.name,
              pluginId: manifest.id,
              description: cmdReg.description,
              handler: cmdReg.handler,
              argsSchema: cmdReg.argsSchema as any,
              help: cmdReg.help,
              autocomplete: cmdReg.autocomplete,
            });
          } catch {
            // Duplicate command name, skip
          }
        }
      }

      loaded.push(plugin);
    }

    return loaded;
  }

  return {
    pluginRegistry,
    toolRegistry,
    hookRegistry,
    runtimeRegistry,
    commandRegistry,
    contextProviders,
    loadFromDirectory,
  };
}
