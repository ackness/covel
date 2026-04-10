/**
 * Plugin & Runtime manifest types.
 *
 * These types represent the parsed result of PLUGIN.md frontmatter.
 * All runtime configuration is defined via YAML frontmatter in PLUGIN.md files.
 */

// ── Plugin classification ────────────────────────────────────────

export type PluginType = 'core-plugin' | 'plugin';

/**
 * Runtime execution type.
 * - `agent` (default): LLM-driven with prompt template, tool calling, context assembly.
 * - `function`: Pure JS/TS function execution, no LLM call. Handler receives execution
 *   context and returns a RuntimeResult-compatible output directly.
 */
export type RuntimeType = 'agent' | 'function';

// ── Trigger system ───────────────────────────────────────────────

export type TriggerType =
  | 'auto'
  | 'manual'
  | 'scheduled'
  | 'conditional'
  | 'event'
  | 'error-retry';

export interface TriggerConfig {
  readonly type: TriggerType;
  /** Interval in turns for `scheduled` mode. */
  readonly interval?: number;
  /** Condition expression for `conditional` mode. */
  readonly condition?: string;
  /** Event topic for `event` mode. */
  readonly topic?: string;
  /** Max trigger count within a session. */
  readonly maxTriggerCount?: number;
  /** Max retry count for `error-retry` mode. */
  readonly maxRetryCount?: number;
  /** Min turns between two triggers. */
  readonly cooldownTurns?: number;
}

// ── Input declarations ───────────────────────────────────────────

export interface InputInjectDecl {
  /** Source: `pluginId/runtimeId` */
  readonly from: string;
  /** Field name to extract from source output. */
  readonly field: string;
  /** XML tag name to wrap the injected data. */
  readonly as: string;
}

export interface InputToolDecl {
  readonly plugin: string;
  readonly runtime: string;
}

export interface InputConfig {
  readonly inject?: readonly InputInjectDecl[];
  readonly tools?: readonly InputToolDecl[];
}

// ── Output declarations ──────────────────────────────────────────

/**
 * How the framework treats this runtime's output in the UI.
 * - `story` — main narrative content, shown in the chat stream.
 * - `plugin` (default) — auxiliary content, may be hidden from main chat.
 * - `system` — system-level output, not shown to the player.
 */
export type OutputKind = 'story' | 'plugin' | 'system';

export interface OutputConfig {
  /** Relative path to output.schema.json. */
  readonly schema?: string;
  /** Record name for other runtimes to query. */
  readonly recordAs?: string;
}

// ── Tool declarations ────────────────────────────────────────────

export interface ToolsConfig {
  /** Builtin tool IDs to enable. */
  readonly builtin?: readonly string[];
  /** Relative paths to local tool modules. */
  readonly local?: readonly string[];
}

// ── Plugin config fields ─────────────────────────────────────────

export type ConfigFieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum';

export interface PluginConfigField {
  readonly type: ConfigFieldType;
  readonly default?: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
  readonly label?: string;
  readonly description?: string;
}

// ── Runtime manifest ─────────────────────────────────────────────

export interface RuntimeManifest {
  readonly name: string;
  /**
   * Plugin ID this runtime belongs to.
   * For single-runtime plugins: same as `name`.
   * For multi-runtime plugins (name = "plugin/sub-runtime"): the part before `/`.
   * Set by the plugin loader during manifest parsing — not declared in PLUGIN.md.
   */
  readonly pluginId: string;
  readonly description: string;
  readonly priority: number;
  readonly version?: string;
  /**
   * Execution type: 'agent' (default) uses LLM pipeline, 'function' runs a pure handler.
   * Function runtimes declare `handler` pointing to a JS module with a default export.
   */
  readonly runtimeType?: RuntimeType;
  /** Relative path to handler module (required for runtimeType: 'function'). */
  readonly handler?: string;
  /**
   * Relative path to a guard function module.
   * Runs before agent execution — if it returns `{ skip: true }`, the LLM call is skipped.
   * The guard receives the same `FunctionHandlerContext` as function runtimes.
   * Guard output is merged into the runtime result's `output` field.
   */
  readonly guard?: string;
  readonly model?: string;
  readonly pluginType?: PluginType;
  /**
   * How the framework treats this runtime's output in the UI.
   * Defaults to `'plugin'`. Only `'story'` outputs are shown in the main chat stream.
   */
  readonly outputKind?: OutputKind;
  /**
   * Capability tags declared by this plugin/runtime.
   * The framework uses these to discover plugins by capability instead of by ID.
   * Examples: `['narrative']`, `['world-data-provider']`, `['image-generation']`.
   */
  readonly capabilities?: readonly string[];
  readonly trigger?: TriggerConfig;
  readonly tools?: ToolsConfig;
  readonly input?: InputConfig;
  readonly output?: OutputConfig;
  readonly config?: Readonly<Record<string, PluginConfigField>>;
  readonly i18n?: Readonly<Record<string, string>>;
}

// ── Plugin manifest ──────────────────────────────────────────────

export interface PluginManifest {
  /** Plugin unique identifier (directory name). */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly pluginType: PluginType;
  readonly version?: string;
  /** Single-runtime plugin: inline runtime config. */
  readonly runtime?: RuntimeManifest;
  /** Multi-runtime plugin: list of runtimes. */
  readonly runtimes?: readonly RuntimeManifest[];
  readonly config?: Readonly<Record<string, PluginConfigField>>;
}
