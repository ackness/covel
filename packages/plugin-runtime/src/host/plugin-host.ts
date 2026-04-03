import { join, resolve, sep } from "node:path";
import { access } from "node:fs/promises";
import { scanPluginDirectory } from "../loader/fs-scanner.js";
import { loadPluginModule } from "../loader/module-loader.js";
import { createPluginRegistry, type PluginRegistry } from "../registry/plugin-registry.js";
import { createToolRegistry, type ToolRegistry } from "../registry/tool-registry.js";
import { createHookRegistry, type HookRegistry } from "../registry/hook-registry.js";
import { createRuntimeRegistry, type RuntimeRegistry } from "../registry/runtime-registry.js";
import { createCommandRegistry, type CommandRegistry } from "../command/command-registry.js";
import type { BlockSchemaDeclaration } from "@covel/shared";
import type { LoadedPlugin, RegisteredContextProvider, ContextProvider } from "../types.js";

export interface PluginHost {
  pluginRegistry: PluginRegistry;
  toolRegistry: ToolRegistry;
  hookRegistry: HookRegistry;
  runtimeRegistry: RuntimeRegistry;
  commandRegistry: CommandRegistry;
  contextProviders: ReadonlyMap<string, RegisteredContextProvider>;
  blockSchemas: ReadonlyMap<string, BlockSchemaDeclaration>;

  /** Scan, validate, load, and register all plugins from a directory. */
  loadFromDirectory(baseDir: string): Promise<LoadedPlugin[]>;

  /** Look up a block schema by block type. */
  getBlockSchema(blockType: string): BlockSchemaDeclaration | undefined;
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
  const blockSchemas = new Map<string, BlockSchemaDeclaration>();

  async function loadFromDirectory(baseDir: string): Promise<LoadedPlugin[]> {
    const scanned = await scanPluginDirectory(baseDir);
    const loaded: LoadedPlugin[] = [];

    // Sort by loadingOrder for deterministic load sequence
    scanned.sort(
      (a, b) => (a.manifest.loadingOrder ?? 100) - (b.manifest.loadingOrder ?? 100)
    );

    // Pre-pass: collect all manifest IDs for dependency validation
    const allManifestIds = new Set(scanned.map((s) => s.manifest.id));

    for (const { dir, manifest } of scanned) {
      // Check dependency/conflict constraints against the full set of manifests
      const constraintErrors = pluginRegistry.validateConstraints(manifest, allManifestIds);
      if (constraintErrors.length > 0) {
        console.warn(
          `[plugin-host] Skipping "${manifest.id}" due to constraint errors:\n` +
            constraintErrors.map((e) => `  - ${e}`).join("\n")
        );
        continue;
      }

      // Register the plugin
      const plugin = pluginRegistry.add(manifest, dir);

      // Register block schemas from manifest
      if (manifest.blockSchemas) {
        for (const schema of manifest.blockSchemas) {
          blockSchemas.set(schema.type, schema);
        }
      }

      // Register runtimes from manifest
      if (manifest.runtimes) {
        for (const spec of manifest.runtimes) {
          let instructionsPath: string | undefined;
          if (spec.instructionsRef) {
            const refPath = resolve(dir, spec.instructionsRef);
            if (!refPath.startsWith(resolve(dir) + sep)) {
              throw new Error(`Unsafe instructionsRef: ${spec.instructionsRef}`);
            }
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
            console.warn(
              `[plugin-host] Tool "${toolId}" from plugin "${manifest.id}" is not declared in the manifest. ` +
                `Registering with default kind "query". Declare it in plugin.json for explicit kind/schema/permissions.`
            );
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
          } catch (err) {
            console.warn(`[plugin-host] Failed to set runtime handler "${manifest.id}:${rtId}":`, err);
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
              argsSchema: cmdReg.argsSchema,
              help: cmdReg.help,
              autocomplete: cmdReg.autocomplete,
            });
          } catch (err) {
            console.warn(`[plugin-host] Failed to register command "${cmdReg.name}" from "${manifest.id}":`, err);
          }
        }
      }

      loaded.push(plugin);
    }

    return loaded;
  }

  function getBlockSchema(blockType: string): BlockSchemaDeclaration | undefined {
    return blockSchemas.get(blockType);
  }

  return {
    pluginRegistry,
    toolRegistry,
    hookRegistry,
    runtimeRegistry,
    commandRegistry,
    contextProviders,
    blockSchemas,
    loadFromDirectory,
    getBlockSchema,
  };
}
