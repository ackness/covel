import type {
  PluginManifest,
  PluginDataAccess,
  PublicRuntimeSpec,
  PublicToolDefinition,
  PublicHookDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  HookEvent,
} from "@covel/shared";

/** A fully loaded and validated plugin. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute path to the plugin directory. */
  dir: string;
  /** Whether the plugin is currently enabled. */
  enabled: boolean;
}

/** Result of scanning a plugin directory. */
export interface ScannedPlugin {
  dir: string;
  manifest: PluginManifest;
}

/** Tool handler function signature. */
export type ToolHandler = (
  ctx: ToolExecutionContext
) => Promise<ToolExecutionResult>;

/** Registered tool with metadata. */
export interface RegisteredTool {
  pluginId: string;
  definition: PublicToolDefinition;
  handler: ToolHandler;
}

/** Hook handler function signature. */
export type HookHandler = (ctx: HookHandlerContext) => Promise<HookHandlerResult>;

/** Context passed to hook handlers. */
export interface HookHandlerContext {
  event: HookEvent;
  runtimeId: string;
  pluginId: string;
  locale: string;
  /** Tool-related data (for PreToolUse/PostToolUse). */
  toolCall?: {
    toolId: string;
    input: unknown;
    output?: unknown;
  };
  /** Proposal data (for PreStateCommit/PostStateCommit). */
  proposals?: unknown[];
}

/** Result from a hook handler. */
export interface HookHandlerResult {
  /** Whether to allow the action to proceed. */
  allow: boolean;
  /** Optional rewritten input (for PreToolUse). */
  rewrittenInput?: unknown;
  /** Optional additional context to inject. */
  context?: Record<string, unknown>;
}

/** Registered hook with metadata. */
export interface RegisteredHook {
  pluginId: string;
  definition: PublicHookDefinition;
  handler: HookHandler;
  loadingOrder: number;
}

/** Context provider function. */
export type ContextProvider = (ctx: ContextProviderInput) => Promise<unknown>;

/** Input for context providers. */
export interface ContextProviderInput {
  pluginId: string;
  runtimeId: string;
  locale: string;
  state?: unknown;
  world?: unknown;
  characters?: unknown[];
}

/** Registered context provider. */
export interface RegisteredContextProvider {
  pluginId: string;
  id: string;
  handler: ContextProvider;
}

/** Command handler function for slash commands. */
export type CommandHandlerFn = (
  args: unknown,
  context: Record<string, unknown>
) => unknown | Promise<unknown>;

/** Command registration info from a plugin. */
export interface CommandRegistration {
  name: string;
  description: string;
  handler: CommandHandlerFn;
  argsSchema?: { safeParse(data: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } } };
  help?: { usage: string; examples?: string[] };
  autocomplete?: {
    positionalHints?: string[];
    flagHints?: Array<{ name: string; description: string; takesValue: boolean }>;
  };
}

/**
 * Interface injected into plugin server/index.ts register() function.
 * Plugins use this to register their contributions.
 */
export interface PluginRegistrar {
  addTool(id: string, handler: ToolHandler): void;
  addHook(id: string, handler: HookHandler): void;
  addContextProvider(id: string, handler: ContextProvider): void;
  addRuntimeHandler(runtimeId: string, handler: RuntimeHandler): void;
  addCommand(registration: CommandRegistration): void;
}

/** Contribution map collected from a plugin's register() call. */
export interface ContributionMap {
  tools: Map<string, ToolHandler>;
  hooks: Map<string, HookHandler>;
  contextProviders: Map<string, ContextProvider>;
  runtimeHandlers: Map<string, RuntimeHandler>;
  commands: CommandRegistration[];
}

/** Plugin server module default export signature. */
export type PluginServerModule = {
  default: (registrar: PluginRegistrar) => void | Promise<void>;
};

// ── Runtime Handler (custom plugin logic, no LLM needed) ────────

/** Context passed to a custom runtime handler. */
export interface RuntimeHandlerContext {
  runtimeId: string;
  pluginId: string;
  locale: string;
  /** Read-only runtime context view from the kernel. */
  context: unknown;
  /** PLUGIN.md content, if available. */
  instructions?: string;
  /** Unified data access interface for reads and proposal helpers. */
  data?: PluginDataAccess;
  /** Optional LLM text generation (injected by kernel when gateway is available). */
  generateText?: (prompt: string) => Promise<string>;
}

/** Result from a custom runtime handler. */
export interface RuntimeHandlerResult {
  proposals: Array<{ kind: string; payload: unknown }>;
}

/**
 * Custom runtime handler function.
 * When registered, the kernel uses this instead of calling the LLM.
 */
export type RuntimeHandler = (
  ctx: RuntimeHandlerContext
) => Promise<RuntimeHandlerResult>;
