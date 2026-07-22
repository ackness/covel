/**
 * Plugin & Runtime manifest types.
 *
 * These types represent the parsed result of PLUGIN.md frontmatter.
 * All runtime configuration is defined via YAML frontmatter in PLUGIN.md files.
 */

// ── Plugin classification ────────────────────────────────────────

export type PluginType = "core-plugin" | "plugin";

/**
 * Runtime execution type.
 * - `agent` (default): LLM-driven with prompt template, tool calling, context assembly.
 * - `function`: Pure JS/TS function execution, no LLM call. Handler receives execution
 *   context and returns a RuntimeResult-compatible output directly.
 */
export type RuntimeType = "agent" | "function";

// ── Trigger system ───────────────────────────────────────────────

/**
 * Runtime trigger modes.
 *
 * Production-active modes (the scheduler actually fires them):
 * - `auto`      — every turn.
 * - `manual`    — only on an explicit `POST /plugin-rpc` request.
 * - `scheduled` — every N turns (`interval`), bounded by `maxTriggerCount`.
 * - `event`     — when a subscribed `topic` is emitted within the turn's
 *                 event fan-out (see `turn-event-chain.ts`).
 *
 * RESERVED modes (schema-accepted for forward-compat, but **never fire** —
 * `shouldTrigger` / the scheduler do not implement them yet; a runtime that
 * declares one stays permanently inactive):
 * - `conditional` — no condition-expression engine is wired.
 *                   `shouldTrigger` returns false and warns once.
 * - `error-retry` — the scheduler never surfaces upstream failures.
 *                   `shouldTrigger` returns false and warns once.
 *
 * Prefer `auto` / `manual` / `scheduled` / `event` until the reserved modes
 * are implemented.
 */
export type TriggerType =
  | "auto"
  | "manual"
  | "scheduled"
  | "event"
  // ── reserved (never fires in production) ──
  | "conditional"
  | "error-retry";

export interface TriggerConfig {
  readonly type: TriggerType;
  /** Interval in turns for `scheduled` mode. */
  readonly interval?: number;
  /** RESERVED — condition expression for `conditional` mode. No engine
   *  evaluates this yet, so a `conditional` runtime never triggers. */
  readonly condition?: string;
  /** Event topic for `event` mode. */
  readonly topic?: string;
  /** Max trigger count within a session. */
  readonly maxTriggerCount?: number;
  /** RESERVED — max retry count for `error-retry` mode. The scheduler never
   *  surfaces upstream failures, so `error-retry` does not fire in production. */
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
 * Inject a field from a completed upstream runtime's output.
 */
export interface RuntimeInjectDecl {
  readonly kind: "runtime";
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
  readonly kind: "plugin-data";
  /** Plugin-data namespace owned by this runtime's plugin. */
  readonly namespace: string;
  /** XML tag wrap, e.g. `"<existing-entries>"`. */
  readonly as: string;
  /** Serialisation format. Defaults to `'summary'`. */
  readonly format?: "summary" | "full" | "ids-only";
  /** Upper bound on entries rendered. Defaults to 50. */
  readonly maxEntries?: number;
}

/**
 * Consume a producer runtime's persisted `recordAs` export from a previous
 * execution. The consumer reads the latest revision committed before this
 * execution started. Functions read `ctx.exports.<name>`; agents receive a
 * same-named prompt segment. Declared but not yet consumed by the framework —
 * consumption lands with the I/O-contract migration step.
 */
export interface RuntimeExportInjectDecl {
  readonly kind: "runtime-export";
  readonly name: string;
  readonly from:
    | { readonly runtime: string }
    | {
        readonly capability: string;
        readonly cardinality?: import("./runtime-scheduling.js").DependencyCardinality;
      };
  readonly recordAs: string;
  readonly accepts?: string;
  readonly required?: boolean;
}

export type InputInjectDecl =
  RuntimeInjectDecl | PluginDataInjectDecl | RuntimeExportInjectDecl;

export interface InputToolDecl {
  readonly plugin: string;
  readonly runtime: string;
}

export interface InputConfig {
  /**
   * Runtime-dir-relative JSON Schema path validating this runtime's
   * activation payload (manual RPC payload / event payload). Function and
   * agent runtimes consume the same validated canonical payload; enforced
   * on `RuntimeActivation.payload` before dispatch.
   */
  readonly schema?: string;
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
export type OutputKind = "story" | "plugin" | "system";

// ── Capability discovery ─────────────────────────────────────────

/**
 * Capability tags the **framework itself** consumes to discover plugins by
 * capability instead of by hardcoded plugin ID. Use these constants in
 * framework code (server / runtime) instead of bare string literals so a
 * typo becomes a compile error rather than a silent `undefined` lookup.
 *
 * Plugins may declare arbitrary custom capability tags beyond this set; the
 * framework only acts on the ones listed here. Keep this in sync with the
 * capability table in `docs/reference/plugins.md`.
 */
export const FrameworkCapability = {
  /** Main narrative generator — identifies the primary story output source. */
  Narrative: "narrative",
  /** World data provider — loads world schema/entries into the turn context. */
  WorldDataProvider: "world-data-provider",
  /** Image generation — frontend shows the "generate image" affordance. */
  ImageGeneration: "image-generation",
  /** Core-memory panel host — memory system mirrors core blocks here. */
  MemoryPanel: "memory-panel",
  /** Player persona provider — supplies the active persona for context. */
  PersonaProvider: "persona-provider",
  /** Prompt history rewriter — folds adopted branches into projected history. */
  PromptHistoryRewriter: "prompt-history-rewriter",
} as const;

/** Union of the framework-consumed capability tag string values. */
export type FrameworkCapabilityTag =
  (typeof FrameworkCapability)[keyof typeof FrameworkCapability];

/**
 * Runtime-level capability tags the **framework itself** consumes to discover a
 * specific *runtime within* a plugin — as opposed to {@link FrameworkCapability},
 * which is matched against the plugin manifest as a whole.
 *
 * These are used by the frontend image pipeline: a multi-step image plugin tags
 * its manual entry runtime `image-prompt` (prompt generator) and its background
 * follower runtime `image-generator` (turns a prompt into an image asset). The
 * framework discovers each runtime by these tags instead of a runtime-name
 * convention. Reference these constants in framework code (web / server) instead
 * of bare string literals so a typo becomes a compile error rather than a silent
 * `?.includes` miss that disables the feature.
 *
 * Plugins may declare arbitrary custom runtime capability tags beyond this set;
 * the framework only acts on the ones listed here.
 */
export const FrameworkRuntimeCapability = {
  /**
   * Entry runtime of a multi-step image plugin — manual trigger, generates the
   * image prompt and hands off to its background `image-generator` follower.
   */
  ImagePrompt: "image-prompt",
  /**
   * Background generator runtime that turns an image prompt into an image asset.
   */
  ImageGenerator: "image-generator",
} as const;

/** Union of the framework-consumed runtime-level capability tag string values. */
export type FrameworkRuntimeCapabilityTag =
  (typeof FrameworkRuntimeCapability)[keyof typeof FrameworkRuntimeCapability];

/**
 * Every capability tag the framework itself acts on — the union of the
 * plugin-level {@link FrameworkCapability} and runtime-level
 * {@link FrameworkRuntimeCapability} values. Single source of truth for:
 *  - `validateRuntimeManifestSemantics`'s typo detection (warns at server
 *    bootstrap when a declared capability looks like a misspelled
 *    framework-known one), and
 *  - keeping the capability table in `docs/reference/plugins.md` honest.
 *
 * Plugins may still declare arbitrary custom capability tags beyond this set;
 * this list only enumerates the tags the framework discovers and dispatches on.
 */
export const FRAMEWORK_KNOWN_CAPABILITIES: readonly string[] = Object.freeze([
  ...Object.values(FrameworkCapability),
  ...Object.values(FrameworkRuntimeCapability),
]);

// ── Core-memory block schema (Letta-style memory) ───────────────

/**
 * Declarative definition of a single core-memory block.
 *
 * Core memory (the `@covel/memory` framework primitive) is **schema-driven**:
 * the framework owns the mechanism (run an LLM extraction, persist, render)
 * but the *meaning* of each block — its label, display name and the
 * extraction guidance handed to the summarizer LLM — is plain data declared
 * by a plugin via the `memoryBlocks` manifest field (or by a world package).
 *
 * This is what lets a detective game declare `clues` / `suspects` / `timeline`
 * and a business sim declare `deals` / `rivals` without forking the framework:
 * the kernel never hardcodes block labels or their extraction prompts.
 */
export interface MemoryBlockSchema {
  /**
   * Stable machine label. Used as the `working_memory` key, the prompt XML
   * tag, and the mirror plugin-data key. Lowercase snake_case by convention.
   */
  readonly label: string;
  /** Localized display name for UI panels and the prompt block heading. */
  readonly displayName: import("./world.js").I18nText;
  /**
   * Per-block guidance injected into the memory summarizer's system prompt —
   * tells the LLM what kind of information belongs in this block. Keep it
   * world-agnostic; world-specific detail comes from the narrative itself.
   */
  readonly extractionHint: import("./world.js").I18nText;
  /** Lucide icon name for UI panels. Defaults to `Info` when omitted. */
  readonly icon?: string;
  /** Optional per-block character cap, overriding the manager default. */
  readonly maxChars?: number;
}

export interface OutputConfig {
  /** Relative path to output.schema.json. */
  readonly schema?: string;
  /** Record name for other runtimes to query. */
  readonly recordAs?: string;
}

// ── Plugin data schemas ─────────────────────────────────────────

export interface PluginDataSchemaDecl {
  /** Plugin-data namespace covered by this schema. */
  readonly namespace: string;
  /** Schema contract version for this namespace. */
  readonly schemaVersion: number;
  /** Whether this namespace can accept imported world-data records. */
  readonly acceptsWorldData: boolean;
  /** Plugin-relative path to a JSON Schema file. */
  readonly schema: string;
  /** Optional author-facing description for tooling and diagnostics. */
  readonly description?: string;
}

// ── Event declarations ───────────────────────────────────────────

/**
 * Declares a domain event a plugin's runtime may emit via the builtin
 * `emit-event` tool. See {@link RuntimeManifest.events} and
 * {@link RuntimeManifest.advertiseEvents}.
 */
export interface PluginEventDecl {
  /** Dot-separated kebab-case topic, e.g. `"scene.set"`. */
  readonly topic: string;
  /** Plugin-relative JSON Schema path validating the event payload. */
  readonly schema: string;
  readonly description: import("./world.js").I18nText;
  /** When true (default) the contract is advertised to emitting runtimes. */
  readonly advertise: boolean;
}

// ── Plugin catalogue metadata ───────────────────────────────────

export type PluginTag = string;

export interface PluginRelationTarget {
  readonly plugin?: string;
  readonly runtime?: string;
  readonly capability?: string;
  readonly tag?: PluginTag;
}

export interface PluginRelation {
  readonly type?: "requires" | "recommends" | "conflicts" | "provides";
  readonly target?: string | PluginRelationTarget;
  readonly plugin?: string;
  readonly runtime?: string;
  readonly capability?: string;
  readonly tag?: PluginTag;
  readonly optional?: boolean;
  readonly reason?: import("./world.js").I18nText;
}

export interface PluginRelations {
  readonly provides?: readonly (string | PluginRelation)[];
  readonly requires?: readonly (string | PluginRelation)[];
  readonly recommends?: readonly (string | PluginRelation)[];
  readonly conflicts?: readonly (string | PluginRelation)[];
}

// ── Tool declarations ────────────────────────────────────────────

export interface ToolsConfig {
  /** Builtin tool IDs to enable. */
  readonly builtin?: readonly string[];
  /**
   * Relative paths to local tool modules.
   * @deprecated Register tools imperatively in the unified `entry` module and
   * list their names under `plugin` instead. All bundled plugins migrated in
   * v0.0.14; this shim (and the legacy `hooks`/`rpc`/`wires` frontmatter
   * fields) is planned for removal in v0.0.17.
   */
  readonly local?: readonly string[];
  /**
   * Names of entry-registered plugin tools this runtime exposes to its LLM
   * (registration itself happens in the plugin's `entry` module).
   */
  readonly plugin?: readonly string[];
  /**
   * Deferred tool loading (tool-search). `true` defers the runtime's entire
   * whitelist; a string array defers just those tool names (for `local`
   * entries, the name is the file basename without extension — same rule as
   * LLM advertisement). Deferred tools stay registered and authorized but
   * are omitted from the initial LLM tool list; the framework injects a
   * `search-tools` tool instead, and tools the LLM discovers through it are
   * activated for the rest of the current turn's agent loop. Use when the
   * whitelist is large (>~10 tools) and per-call schema preloading would
   * dominate the prompt budget.
   */
  readonly defer?: true | readonly string[];
}

// ── User-declared plugin settings ────────────────────────────────

/**
 * A user-editable setting declared by a plugin in its PLUGIN.md
 * frontmatter. The framework renders these in the Settings UI under
 * `Plugins > <pluginId>` and stores values under
 * `plugin.<pluginId>.<key>` in the unified SettingsStore.
 */
export interface PluginUserSettingSpec {
  readonly key: string;
  // `integer` is a `number` constrained to whole values; `slider` is a
  // `number` rendered as a range control (declare `min`/`max`). `secret` is
  // intentionally not yet supported — its keys.env storage + transport channel
  // are unresolved (see the configurable-surface spec, Open Question #4).
  readonly type:
    "text" | "textarea" | "number" | "integer" | "toggle" | "select" | "slider";
  // Optional: a setting may declare no default (e.g. cost-gate). Mirrors the
  // schema's `z.unknown().optional()` so the parsed manifest type-checks.
  readonly default?: unknown;
  readonly label: import("./world.js").I18nText;
  readonly description?: import("./world.js").I18nText;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: ReadonlyArray<{
    readonly value: string;
    readonly label: import("./world.js").I18nText;
  }>;
}

// ── Hook declarations ────────────────────────────────────────────
//
// The hook event tuple, its derived union, the enforce group, and the
// declaration shape now live in ./hooks.ts (single source of truth). They are
// re-exported here so existing `@covel/shared` consumers and the types barrel
// keep importing them from the same place. `HookDeclaration` is also imported
// locally below because `RuntimeManifest.hooks` references it.
import type { HookDeclaration } from "./hooks.js";
export { HOOK_EVENTS } from "./hooks.js";
export type { HookEventName, HookEnforce, HookDeclaration } from "./hooks.js";

// ── UI declarations ─────────────────────────────────────────────

/**
 * UI slot type — where plugin UI contributions appear in the frontend.
 * - `right`: Right sidebar panel tabs (status panels, dashboards)
 * - `message`: Inline blocks in the chat message area
 * - `left`: Left sidebar content (settings, quick actions)
 */
export type UISlotType = "right" | "message" | "left";

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

/**
 * One entry in `upstreamRequired`. Either:
 *  • a runtime id (string) — that exact runtime must have succeeded; an absent
 *    (disabled) upstream still skips this runtime, never counts as success.
 *  • `{ capability }` — at least one in-scope runtime declaring that capability
 *    must have succeeded. Lets a runtime depend on "the active provider of X"
 *    (e.g. `narrative`) without naming a concrete plugin, so the same downstream
 *    works across modes that swap the provider (narrator ↔ chat-mode-narrator).
 */
export type UpstreamRequirement = string | { readonly capability: string };

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
  /**
   * Friendly, player-facing name (I18nText). Distinct from `name` (the runtime
   * id). Surfaced via `PluginSummary.displayName` for plugin-list UIs so a
   * non-Chinese player sees e.g. "Action Guide" instead of the id "guide".
   */
  readonly displayName?: import("./world.js").I18nText;
  readonly priority?: number;
  readonly version?: string;
  /**
   * Execution type: 'agent' (default) uses LLM pipeline, 'function' runs a pure handler.
   * Function runtimes declare `handler` pointing to a JS module with a default export.
   */
  readonly runtimeType?: RuntimeType;
  /** Relative path to handler module (required for runtimeType: 'function'). */
  readonly handler?: string;
  /**
   * Plugin-root-relative path to a media-wires module (resolved from the
   * plugin root, NOT the runtime dir — same convention as `tools.local`).
   * Default export: `{ image?, speech?, transcription? }` arrays of wire
   * objects, or a factory `(inject: { fetchWithRetry, validateBaseUrl }) =>`
   * that shape. Loaded once per plugin (trust-gated like local tools);
   * registered wire ids are prefixed `"<pluginId>/"`. Declare on ONE
   * runtime per plugin.
   */
  readonly wires?: string;
  /**
   * Plugin-root-relative path to a unified server entry module. Default
   * export: `function (covel: PluginAPI) { ... }` (sync or async) that
   * registers the plugin's server-side capabilities imperatively —
   * `covel.registerTool()`, `covel.on(event, handler)`,
   * `covel.registerRpc()`, `covel.registerWires()` — replacing the legacy
   * `tools.local` / `hooks` / `rpc` / `wires` frontmatter fields (which
   * keep working for one deprecation cycle). Declare on ONE runtime per
   * plugin (root PLUGIN.md by convention); loaded once per plugin,
   * trust-gated like local tools (builtin/official at boot, community on
   * activation).
   */
  readonly entry?: string;
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
  /**
   * How many times to retry on transient LLM failures (first-token timeout,
   * total call timeout, network / 5xx / rate-limit, tool-call loop). Default 1
   * (at most one retry, so up to 2 attempts total). Each retry injects a
   * small perturbation into the messages to break deterministic KV-cache hits
   * that can otherwise reproduce the same hang. Set to 0 to disable retry.
   */
  readonly maxRetries?: number;
  /**
   * Per-LLM-call total timeout in ms. Caps a single provider call so a hung
   * request cannot consume the whole `timeoutMs` budget. Defaults to
   * `min(60000, floor(timeoutMs / (maxRetries + 1)))` so every retry attempt
   * fits inside the runtime deadline.
   */
  readonly callTimeoutMs?: number;
  /**
   * Streaming first-token (TTFB) timeout in ms. Fires when a streaming LLM
   * call is established but emits no text/tool-call event before the
   * threshold — typical symptom of a hung provider with a live TCP socket.
   * Default 30000. Ignored for non-streaming calls.
   */
  readonly firstTokenTimeoutMs?: number;
  /**
   * Tool-call loop detection threshold. When the LLM emits `N` consecutive
   * tool calls with identical `{name, arguments}`, the executor aborts the
   * current attempt and retries (with perturbation) to break the loop.
   * Default 3. Set to 0 to disable loop detection.
   */
  readonly loopDetectionThreshold?: number;
  /**
   * Agent runtimes only. When `true`, a loop that finishes without ever
   * successfully executing a tool (LLM returned prose with no tool call) is
   * given one corrective retry — a system message telling it to call its
   * declared tool first — before being allowed to finish. Guards against
   * models that drift into free-form narration and skip their sole tool.
   * `maxSteps` still bounds the loop, so a second bare finish is released
   * (with a warn) rather than looping forever. Default `false`.
   */
  readonly requireToolUse?: boolean;
  /**
   * Maximum nested `ctx.recursiveCall()` depth for this runtime. Defaults
   * to the executor limit, currently 10. Depth starts at 0 for a top-level
   * turn and increments once per recursive call.
   */
  readonly maxRecursionDepth?: number;
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
  /**
   * User-facing catalogue tags for filtering and scenario matching.
   * These complement `capabilities`: capabilities are machine-discovery
   * contracts, tags are faceted metadata for players and pack resolution.
   */
  readonly tags?: readonly PluginTag[];
  /**
   * Optional dependency/conflict/provided-feature metadata used by plugin
   * selection UIs and future resolvers. Runtime execution semantics still
   * come from triggers, input.inject, upstreamRequired, and scheduler config.
   */
  readonly relations?: PluginRelations;
  /**
   * Upstreams this runtime depends on for a successful output. Each entry is a
   * runtime id or a `{ capability }` requirement (see {@link UpstreamRequirement}).
   * When a required upstream ran with `status !== 'success'` in the same turn —
   * or, for a capability entry, no in-scope provider succeeded — the framework
   * short-circuits this runtime with `status: 'skipped'` before the guard / LLM
   * pipeline. Prevents downstream LLMs from being invoked with empty inject
   * blocks when their upstream failed.
   *
   * Implemented in packages/runtime/src/turn-executor.ts (executeOneRuntime).
   */
  readonly upstreamRequired?: readonly UpstreamRequirement[];
  /**
   * Named scheduling stage (replaces numeric priority bands). Required for
   * `auto` / `scheduled` runtimes under the strict authoring schema;
   * forbidden for `event` / `manual`. During the compat period legacy
   * manifests keep using `priority` and the loader derives the stage from
   * the band. Declared but not yet consumed by the production scheduler.
   */
  readonly stage?: import("./runtime-scheduling.js").Stage;
  /**
   * Weak ordering dependencies (pure ordering, no gate). Target failure or
   * absence never blocks this runtime. Declared but not yet consumed.
   */
  readonly after?: readonly import("./runtime-scheduling.js").DependencyRef[];
  /**
   * Strong dependencies: ordering + gate. `scope: turn` (default) requires
   * same-execution success; `scope: session` gates on the persistent
   * snapshot frozen at execution start (setup runtimes only). Supersedes
   * `upstreamRequired` (kept as a compat alias). Declared but not yet
   * consumed by the production scheduler.
   */
  readonly needs?: readonly import("./runtime-scheduling.js").DependencyRef[];
  /**
   * Typed same-execution data bindings. `required: true` implies
   * `needs(turn)`, `false` implies `after`. Resolved into provenance-wrapped
   * `ctx.inputs` slots (function) / a reserved prompt block (agent), with a
   * turn gate on required bindings.
   */
  readonly inputs?: Readonly<
    Record<string, import("./runtime-scheduling.js").RuntimeBinding>
  >;
  /**
   * How the normalizer parses this runtime's handler return value.
   * `legacy` (default): whole return object preserved as the value with
   * known control keys copied to effects. `envelope-v1`: explicit
   * HandlerResult discriminated union with value validation (observe-only
   * for function runtimes until the I/O-contract step enforces it).
   */
  readonly resultFormat?: import("./runtime-scheduling.js").RuntimeResultFormat;
  /**
   * Function runtimes only: handler may be replayed from a frozen
   * activation boundary to resume approval/HTTP asks. Default false.
   */
  readonly suspensionSafe?: boolean;
  /**
   * Explicit read/write-set override for parallel hazard detection.
   * Defaults are derived from declared builtin tools + proposal types.
   * Declared but not yet consumed.
   */
  readonly effects?: import("./runtime-scheduling.js").EffectsDecl;
  /**
   * Declared permission upper bounds. `http` lists canonical HTTPS origins
   * (+ methods) this plugin may call through the Public Plugin API.
   * Declared but not yet enforced.
   */
  readonly permissions?: {
    readonly http?: readonly import("./runtime-scheduling.js").HttpPermissionDecl[];
  };
  /**
   * Compat-period projection of kernel job-status records into this
   * plugin's legacy plugin-data views. Rejected by the strict authoring
   * schema. Declared but not yet consumed.
   */
  readonly jobStatus?: {
    readonly legacyViews?: readonly import("./runtime-scheduling.js").LegacyJobViewDecl[];
  };
  readonly trigger?: TriggerConfig;
  /**
   * Execution mode when this runtime is activated via a manual plugin-rpc call
   * (or later, through background-capable event chains).
   *
   * - `'sync'` (default): caller awaits runtime completion; proposals commit
   *   inside the request/response cycle.
   * - `'background'`: server schedules the runtime, returns immediately with
   *   a `jobId`, and pushes progress / result over the `_jobs` plugin-data
   *   namespace (SSE `plugin-data.changed`).
   *
   * Ignored for runtimes triggered by the normal per-turn scheduler.
   */
  readonly execution?: "sync" | "background";
  /**
   * When true, the session-level event directory (aggregated across all
   * active runtimes' `events` declarations) is rendered into this runtime's
   * segment 5 prompt so the LLM knows which topics it may emit via the
   * builtin `emit-event` tool. Defaults to `undefined` (not advertised).
   */
  readonly advertiseEvents?: boolean;
  readonly tools?: ToolsConfig;
  readonly input?: InputConfig;
  readonly output?: OutputConfig;
  readonly dataSchemas?: Readonly<Record<string, PluginDataSchemaDecl>>;
  /** Domain events this plugin's runtime may emit via `emit-event`. */
  readonly events?: readonly PluginEventDecl[];
  readonly i18n?: Readonly<Record<string, string>>;
  readonly ui?: UISpec;
  /**
   * User-facing settings the plugin exposes in the Settings UI.
   * Each entry is auto-registered under `plugin.<pluginId>.<key>` in the
   * unified SettingsStore and rendered as a form field in the Plugins tab.
   *
   * See `PluginUserSettingSpec` for the allowed shape. Plugins read values
   * through their runtime context; the framework handles persistence.
   */
  readonly userSettings?: readonly PluginUserSettingSpec[];
  /**
   * Hook declarations for this runtime.
   * Each entry registers a lifecycle handler loaded lazily on first invocation.
   * See HookDeclaration for the full contract.
   */
  readonly hooks?: readonly HookDeclaration[];
  /**
   * Sections of the narrative/output this runtime considers important for
   * history compaction (the Compactor). The compactor collects these
   * across all active runtimes and asks the LLM to preserve those topics
   * when summarising old message spans.
   *
   * Examples: `['narrative', 'character-state', 'world-facts']`
   */
  readonly summaryFocus?: readonly string[];
  /**
   * Author's Note prompt segment — director-grade instruction
   * inserted near the end of the message history, just before the Nth-from-last
   * message. Modeled after SillyTavern / NovelAI author's-note semantics.
   *
   * The content supports template interpolation (`{{ player.xxx }}`, etc.)
   * identical to the plugin body. Multiple active plugins' notes are merged
   * in (stage, name) order.
   */
  readonly authorsNote?: AuthorsNoteDecl;
  /**
   * Post-History Instructions prompt segment — final
   * high-weight instruction appended after the last message. Used to
   * re-anchor the model on output format, style constraints, or
   * hard rules that should survive long histories.
   */
  readonly postHistory?: PostHistoryDecl;
  /**
   * Plugin RPC action declarations.
   *
   * Maps action name → `RpcActionDecl`. Each entry registers a structured
   * command the plugin exposes through `POST /api/sessions/:id/plugin-rpc`,
   * dispatched as `{ pluginId, action, payload }`.
   *
   * Handlers are loaded lazily on first dispatch — there is no eager
   * import at parse time. Trust level defaults to the plugin's source
   * trust (builtin/official auto-allowed; community gated by the RPC
   * approval flow).
   *
   * Action names must be kebab-case. Names starting with `framework-`
   * are reserved for framework default handlers and will be rejected
   * by the loader.
   */
  readonly rpc?: import("./rpc.js").RpcDeclMap;
  /**
   * Core-memory block definitions contributed by this plugin (or world).
   *
   * The framework's memory system (`@covel/memory`) aggregates `memoryBlocks`
   * across all loaded plugins to drive post-turn extraction and prompt
   * rendering — block labels and extraction prompts are therefore plain data,
   * not hardcoded kernel behavior. The builtin `memory` plugin declares the
   * default narrative blocks (`story_state` / `scene` /
   * `character_relationships` / `player_profile`); any plugin or world can add
   * its own (e.g. `clues` / `suspects` / `timeline`).
   */
  readonly memoryBlocks?: readonly MemoryBlockSchema[];
}

// ── Author's note / Post-history declarations ───────────

/**
 * Declaration for prompt segment 9 — "director's note" inserted
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
  readonly role?: "system" | "user" | "assistant";
}

/**
 * Declaration for prompt segment 10 — high-weight instruction appended
 * after the last message.
 */
export interface PostHistoryDecl {
  /** Interpolated text to inject. Supports `{{ template }}` variables. */
  readonly content: string;
  /** Message role used to wrap the note. Defaults to `system`. */
  readonly role?: "system" | "user";
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
}
