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
  /** Session phases in which this runtime is allowed to trigger. If omitted, triggers in all phases. */
  readonly phases?: readonly string[];
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

// ── Hook declarations ────────────────────────────────────────────

/**
 * Hook event names a plugin runtime can register handlers for.
 * Mirrors HookEvent in @covel/runtime — kept here so plugin authors can
 * reference it from shared types without depending on the runtime package.
 */
export type HookEventName =
  | 'TurnStart'
  | 'PreRuntime'
  | 'PostRuntime'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreStateCommit'
  | 'PostStateCommit'
  | 'TurnStop';

/**
 * Single hook declaration in PLUGIN.md frontmatter.
 * Handler files are resolved lazily — no eager import at parse time.
 */
export interface HookDeclaration {
  readonly event: HookEventName;
  /** Relative path to the handler module inside the plugin package. */
  readonly handler: string;
  /** Optional simple equality filter: { tool: "my-tool" } etc. */
  readonly match?: Readonly<Record<string, string | number>>;
  /** Per-handler timeout in ms. Default 5000. */
  readonly timeoutMs?: number;
}

// ── UI declarations ─────────────────────────────────────────────

/**
 * UI slot type — where plugin UI contributions appear in the frontend.
 * - `right`: Right sidebar panel tabs (status panels, dashboards)
 * - `message`: Inline blocks in the chat message area
 * - `left`: Left sidebar content (settings, quick actions)
 */
export type UISlotType = 'right' | 'message' | 'left';

/**
 * UI contribution spec — declares which JSON/TSX files a plugin contributes
 * to each UI slot. Mirrors the tools declaration pattern.
 *
 * Paths are relative to the plugin/runtime root directory.
 * File extension determines rendering: .json → json-render, .tsx/.js → custom React.
 */
export interface UISpec {
  /** Right sidebar panel specs. */
  readonly right?: readonly string[];
  /** Message area block specs. */
  readonly message?: readonly string[];
  /** Left sidebar content specs. */
  readonly left?: readonly string[];
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
  readonly ui?: UISpec;
  /**
   * Hook declarations for this runtime.
   * Each entry registers a lifecycle handler loaded lazily on first invocation.
   * See HookDeclaration for the full contract.
   */
  readonly hooks?: readonly HookDeclaration[];
  /**
   * Sections of the narrative/output this runtime considers important for
   * history compaction (S2-T2 Compactor). The compactor collects these
   * across all active runtimes and asks the LLM to preserve those topics
   * when summarising old message spans.
   *
   * Examples: `['narrative', 'character-state', 'world-facts']`
   */
  readonly summaryFocus?: readonly string[];
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
