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
  /**
   * First main-loop turn at which this runtime may trigger. Optional —
   * when unset the runtime triggers as soon as its band (100-1000) opens.
   * Compared against `turnNumber` directly.
   */
  readonly startTurn?: number;
}

// ── Input declarations ───────────────────────────────────────────

/**
 * Inject a field from a completed upstream runtime's output (legacy shape).
 *
 * The `kind: 'runtime'` discriminator is materialised by the schema
 * `preprocess` step. PLUGIN.md files may omit it — the legacy
 * `{ from, field, as }` shape is still accepted and normalised at parse time.
 */
export interface RuntimeInjectDecl {
  readonly kind: 'runtime';
  /** Runtime name: `pluginId/runtimeId` or short `pluginId`. */
  readonly from: string;
  /** Field name to extract from source output. */
  readonly field: string;
  /** XML tag wrap, e.g. `"<narrator-output>"`. */
  readonly as: string;
}

/**
 * Inject a summary of the current runtime's OWN plugin-data namespace into
 * the prompt. The framework calls `store.listPluginData(sessionId, pluginId,
 * namespace)` before building the system prompt and inlines a deterministic,
 * truncated view under the declared XML tag.
 *
 * Cross-plugin reads are intentionally NOT supported — always reads from
 * the runtime's own `pluginId`.
 *
 * `format`:
 * - `summary` (default): one line per entry `- {key} | {updatedAt} | {json-truncated-200}`
 * - `ids-only`: one line per entry `- {key}` — cheapest, loses content
 * - `full`: one line per entry `- {key}: {full-json}` — most expensive
 *
 * `maxEntries` bounds the prompt size. When exceeded, a two-pass truncation
 * reserves half the quota for the oldest entries (stable anchors by
 * `createdAt`) and half for the most recently updated (active head by
 * `updatedAt`), with deduplication. See `@covel/context` for the algorithm.
 */
export interface PluginDataInjectDecl {
  readonly kind: 'plugin-data';
  /** Plugin-data namespace owned by this runtime's plugin. */
  readonly namespace: string;
  /** XML tag wrap, e.g. `"<existing-entries>"`. */
  readonly as: string;
  /** Serialisation format. Defaults to `'summary'`. */
  readonly format?: 'summary' | 'full' | 'ids-only';
  /** Upper bound on entries rendered. Defaults to 50. */
  readonly maxEntries?: number;
}

export type InputInjectDecl = RuntimeInjectDecl | PluginDataInjectDecl;

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
  readonly priority?: number;
  readonly version?: string;
  /**
   * Prompt assembler version (S2-T4).
   * - `1` or omitted: V1 single-pass `buildContext`.
   * - `2`: V2 three-tier assembler (segments 1–10).
   *
   * The runtime only routes a manifest to V2 when **both** the environment
   * flag `COVEL_PROMPT_V2=1` and `promptVersion: 2` are set. This double gate
   * keeps migration opt-in at both the deployment level (env flag) and the
   * plugin level (manifest field) per §A8 of the improvement plan.
   */
  readonly promptVersion?: 1 | 2;
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
  /**
   * Per-runtime hard timeout in ms.
   * Overrides the executor default for agent runtimes.
   */
  readonly timeoutMs?: number;
  /**
   * Per-runtime cap on the agent tool-call loop. Overrides the framework
   * default (10). Lower values prevent runaway LLMs that keep calling the
   * same tool after a successful result. Set to 1 or 2 for single-shot
   * plugins that should call one tool and stop.
   */
  readonly maxSteps?: number;
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
  /**
   * Author's Note (S3-T4, V2 prompt segment 9) — director-grade instruction
   * inserted near the end of the message history, just before the Nth-from-last
   * message. Modeled after SillyTavern / NovelAI author's-note semantics.
   *
   * The content supports template interpolation (`{{ config.xxx }}`, etc.)
   * identical to the plugin body. Multiple active plugins' notes are merged
   * in priority order.
   *
   * Only applied by the V2 prompt assembler (`COVEL_PROMPT_V2=1`).
   */
  readonly authorsNote?: AuthorsNoteDecl;
  /**
   * Post-History Instructions (S3-T4, V2 prompt segment 10) — final
   * high-weight instruction appended after the last message. Used to
   * re-anchor the model on output format, style constraints, or
   * hard rules that should survive long histories.
   *
   * Only applied by the V2 prompt assembler (`COVEL_PROMPT_V2=1`).
   */
  readonly postHistory?: PostHistoryDecl;
  /**
   * PR-3: Plugin RPC action declarations.
   *
   * Maps action name → `RpcActionDecl`. Each entry registers a structured
   * command the plugin exposes through `POST /api/sessions/:id/plugin-rpc`,
   * dispatched as `{ pluginId, action, payload }`.
   *
   * Handlers are loaded lazily on first dispatch — there is no eager
   * import at parse time. Trust level defaults to the plugin's source
   * trust (builtin/official auto-allowed; community gated by PR-7
   * approval flow).
   *
   * Action names must be kebab-case. Names starting with `framework-`
   * are reserved for framework default handlers and will be rejected
   * by the loader.
   */
  readonly rpc?: import('./rpc.js').RpcDeclMap;
}

// ── Author's note / Post-history declarations (S3-T4) ───────────

/**
 * Declaration for V2 prompt segment 9 — "director's note" inserted
 * near the end of the message history.
 */
export interface AuthorsNoteDecl {
  /** Interpolated text to inject. Supports `{{ template }}` variables. */
  readonly content: string;
  /**
   * Insertion depth measured from the END of the message array.
   * A value of `4` places the note before `messages[length - 4]`.
   * Defaults to `4` (SillyTavern default). Values `<= 0` mean "append at end".
   */
  readonly depth?: number;
  /** Message role used to wrap the note. Defaults to `system`. */
  readonly role?: 'system' | 'user' | 'assistant';
}

/**
 * Declaration for V2 prompt segment 10 — high-weight instruction appended
 * after the last message.
 */
export interface PostHistoryDecl {
  /** Interpolated text to inject. Supports `{{ template }}` variables. */
  readonly content: string;
  /** Message role used to wrap the note. Defaults to `system`. */
  readonly role?: 'system' | 'user';
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
