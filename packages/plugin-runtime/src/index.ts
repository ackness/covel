// ── Types ──────────────────────────────────────────────────────────
export type {
  LoadedPlugin,
  ScannedPlugin,
  ToolHandler,
  RegisteredTool,
  HookHandler,
  HookHandlerContext,
  HookHandlerResult,
  RegisteredHook,
  ContextProvider,
  ContextProviderInput,
  RegisteredContextProvider,
  PluginRegistrar,
  ContributionMap,
  PluginServerModule,
  RuntimeHandler,
  RuntimeHandlerContext,
  RuntimeHandlerResult,
  CommandHandlerFn,
  CommandRegistration,
} from "./types.js";

// ── Loader ─────────────────────────────────────────────────────────
export { validateManifest, pluginManifestSchema } from "./loader/manifest-validator.js";
export { scanPluginDirectory } from "./loader/fs-scanner.js";
export { loadPluginModule } from "./loader/module-loader.js";

// ── Registries ─────────────────────────────────────────────────────
export { createPluginRegistry, type PluginRegistry } from "./registry/plugin-registry.js";
export { createToolRegistry, type ToolRegistry } from "./registry/tool-registry.js";
export { createHookRegistry, type HookRegistry } from "./registry/hook-registry.js";
export {
  createRuntimeRegistry,
  type RuntimeRegistry,
  type RegisteredRuntime,
} from "./registry/runtime-registry.js";

// ── Commands ───────────────────────────────────────────────────────
export {
  createCommandRegistry,
  type CommandRegistry,
  type RegisteredCommand,
  type CommandSummary,
  type CommandExecutionContext,
  type CommandHandler,
  type CommandHelpMeta,
  type CommandAutocompleteMeta,
  type CommandFlagHint,
} from "./command/command-registry.js";
export { createCommandBus, type CommandBus, type CommandResult } from "./command/command-bus.js";
export { parseSlashCommand, type ParsedSlashCommand, type ParsedSlashArgs } from "./command/parser.js";
export { CommandError, type CommandErrorCode, type CommandIssue } from "./command/error.js";

// ── Host ───────────────────────────────────────────────────────────
export { createPluginHost, type PluginHost } from "./host/plugin-host.js";
