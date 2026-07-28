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
 * The four production modes (the historical `conditional` / `error-retry`
 * values were removed from the enum — manifests declaring them are rejected
 * at load):
 * - `auto`      — every turn.
 * - `manual`    — only on an explicit `POST /plugin-rpc` request.
 * - `scheduled` — every N turns (`interval`), bounded by `maxTriggerCount`.
 * - `event`     — when a subscribed `topic` is emitted within the turn's
 *                 event fan-out (see `turn-event-chain.ts`).
 */
export type TriggerType = "auto" | "manual" | "scheduled" | "event";

export interface TriggerConfig {
  readonly type: TriggerType;
  /** Interval in turns for `scheduled` mode. */
  readonly interval?: number;
  /** Event topic for `event` mode. */
  readonly topic?: string;
  /** Max trigger count within a session. */
  readonly maxTriggerCount?: number;
  /** Min turns between two triggers. */
  readonly cooldownTurns?: number;
  /**
   * First main-loop turn at which this runtime may trigger. Optional —
   * when unset the runtime triggers as soon as its stage opens.
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
 * same-named prompt segment. Resolved by
 * `@covel/runtime`'s `schedule/input-bindings.ts` (`exportBindings`).
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

/**
 * Plugin catalogue relations. Each entry is a plain string: a plugin id
 * (`scene-cast`) or `pluginId/runtimeId` — EXCEPT under `provides`, where the
 * string is an opaque capability label two plugins can share to mark
 * themselves as interchangeable (`narrator` and `chat-mode-narrator` both
 * provide `narrative-engine`, which is how one may replace the other).
 *
 * An entry is deliberately just a string. Earlier versions also accepted an
 * object form carrying `target` / `plugin` / `runtime` / `type` / `optional` /
 * `reason`, i.e. four interchangeable ways to write a plugin id plus three
 * fields no code ever read — resolution only ever extracted the id
 * (`relationPluginId`, session-plugins route), the frontend forwards relations
 * as an opaque blob, and `optional: true` under `requires` was just
 * `recommends` spelled differently. Explain a dependency with a YAML comment
 * above it, the way the bundled plugins already do.
 *
 * Capability-based *scheduling* dependencies are a separate, working
 * mechanism — see {@link RuntimeManifest.needs} / `after`.
 */
export interface PluginRelations {
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
  readonly recommends?: readonly string[];
  readonly conflicts?: readonly string[];
}

// ── Tool declarations ────────────────────────────────────────────

export interface ToolsConfig {
  /** Builtin tool IDs to enable. */
  readonly builtin?: readonly string[];
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
  // `number` rendered as a range control (declare `min`/`max`). `slot` is a
  // `string` naming an `llm.toml` `[covel.<slot>]` section — the framework
  // renders the configured slots as a picker and auto-binds the declared
  // default, so a plugin never has to make the player type a slot id.
  // `secret` is intentionally not yet supported — its keys.env storage +
  // transport channel are unresolved (see the configurable-surface spec,
  // Open Question #4).
  readonly type:
    | "text"
    | "textarea"
    | "number"
    | "integer"
    | "toggle"
    | "select"
    | "slider"
    | "slot";
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

// ── Plugin-scoped manifest fields ────────────────────────────────

/**
 * How a plugin-scoped field behaves when more than one runtime of the same
 * plugin declares it. See {@link PLUGIN_SCOPED_FIELDS} for the per-field
 * assignment and {@link PluginScopedManifestFields} for the fields themselves.
 */
export type PluginScopedMergeKind =
  /** Every declaration is loaded; duplicates collapse by value. */
  | "union"
  /** Declarations merge on a key; a divergent redeclaration is a conflict. */
  | "keyed"
  /** Only the root PLUGIN.md is read; runtime declarations are ignored. */
  | "root-only";

/**
 * The plugin-scoped manifest fields and how each one merges across a plugin's
 * runtimes — the single place that knowledge lives.
 *
 * These fields are declared on a *runtime* manifest (PLUGIN.md frontmatter is
 * one schema) but consumed at *plugin* scope, so a multi-runtime plugin can
 * declare the same field more than once and the framework has to decide what
 * that means. It decided differently for every field, in six different files,
 * and a new field added without noticing this is how `userSettings` shipped
 * with no conflict handling at all while `dataSchemas` throws.
 *
 * Adding a field to {@link PluginScopedManifestFields} without registering it
 * here is a compile error (see the exhaustiveness check below), which is the
 * point: you cannot add a plugin-scoped field without stating its merge rule.
 *
 * `conflict` documents what happens on a divergent redeclaration; `where`
 * points at the code that implements it, since none of this lives in one place.
 */
export const PLUGIN_SCOPED_FIELDS = {
  /** Every declared path runs, including the root's; the path set dedupes. */
  entry: {
    merge: "union",
    conflict: "none — distinct paths all execute against the same pluginId",
    where: "apps/server/src/routes/api/bootstrap/plugin-entry.ts",
  },
  /** Every declared module loads; wire ids are namespaced `<pluginId>/`. */
  wires: {
    merge: "union",
    conflict: "none at load; duplicate wire ids resolve in the wire registry",
    where: "apps/server/src/routes/api/bootstrap/plugin-wires.ts",
  },
  /** Merged on `key`; all runtimes share `plugin.<pluginId>.<key>`. */
  userSettings: {
    merge: "keyed",
    conflict: "warn, first declaration wins",
    where: "apps/server/src/routes/misc-api/plugin-catalog.ts",
  },
  /** Merged on namespace — the strictest of the set. */
  dataSchemas: {
    merge: "keyed",
    conflict: "throws — the plugin fails to register",
    where: "packages/plugin-loader/src/registry.ts",
  },
  /** Merged on `label` across ALL plugins, not just this one. */
  memoryBlocks: {
    merge: "keyed",
    conflict: "higher trust tier wins; equal tier is first-wins",
    where: "apps/server/src/routes/api/bootstrap/memory.ts",
  },
  /** Merged on `topic` across all active runtimes of the session. */
  events: {
    merge: "keyed",
    conflict: "first-wins; warns only when the clash is cross-plugin",
    where: "apps/server/src/routes/api/bootstrap/event-directory.ts",
  },
  /** Unioned and sorted for the catalogue. */
  tags: {
    merge: "union",
    conflict: "none — deduped",
    where: "apps/server/src/routes/misc-api/plugin-catalog.ts",
  },
  /**
   * Split behaviour: the lightweight summary reads whichever manifest it
   * loaded, while session dependency resolution unions every runtime's.
   */
  relations: {
    merge: "union",
    conflict: "none — resolution unions all runtimes",
    where: "apps/server/src/routes/api/session/plugins.ts (entryRelations)",
  },
  /** Read from the root PLUGIN.md only — see loadPluginSummary's comment. */
  displayName: {
    merge: "root-only",
    conflict:
      "n/a — a runtime's displayName names that runtime, not the plugin",
    where: "packages/plugin-loader/src/load.ts",
  },
} as const satisfies Record<
  string,
  { merge: PluginScopedMergeKind; conflict: string; where: string }
>;

/**
 * Fields declared per-runtime but consumed per-plugin. Split out of
 * {@link RuntimeManifest} so the distinction is visible in the type rather
 * than only in prose, and so {@link PLUGIN_SCOPED_FIELDS} has something to be
 * checked against. `RuntimeManifest` extends this, so every existing
 * `manifest.<field>` access is unaffected.
 */
export interface PluginScopedManifestFields {
  /**
   * Friendly, player-facing name (I18nText). Distinct from `name` (the runtime
   * id). Surfaced via `PluginSummary.displayName` for plugin-list UIs so a
   * non-Chinese player sees e.g. "Action Guide" instead of the id "guide".
   * Only the root PLUGIN.md's value is read.
   */
  readonly displayName?: import("./world.js").I18nText;
  /**
   * Plugin-root-relative path to a media-wires module (resolved from the
   * plugin root, NOT the runtime dir — same convention as `tools.local`).
   * Default export: `{ image?, speech?, transcription? }` arrays of wire
   * objects, or a factory `(inject: { fetchWithRetry, validateBaseUrl }) =>`
   * that shape. Trust-gated like local tools; registered wire ids are prefixed
   * `"<pluginId>/"`. Conventionally declared once, on the root PLUGIN.md —
   * but every declared path is loaded, so two runtimes naming different
   * modules get both.
   */
  readonly wires?: string;
  /**
   * Plugin-root-relative path to a unified server entry module. Default
   * export: `function (covel: PluginAPI) { ... }` (sync or async) that
   * registers the plugin's server-side capabilities imperatively —
   * `covel.registerTool()`, `covel.on(event, handler)`,
   * `covel.registerRpc()`, `covel.registerWires()` — replacing the legacy
   * registration fields. `tools.local` is GONE (declaring it fails the load);
   * `hooks` / `rpc` / `wires` still parse but are deprecated. Conventionally
   * declared once, on the root PLUGIN.md — but every declared path executes
   * (the root's included, and the set dedupes), all against the same
   * `pluginId`. Trust-gated like local tools (builtin/official at boot,
   * community on activation).
   */
  readonly entry?: string;
  /**
   * User-facing catalogue tags for filtering and scenario matching.
   * These complement `capabilities`: capabilities are machine-discovery
   * contracts, tags are faceted metadata for players and pack resolution.
   * Unioned across the plugin's runtimes.
   */
  readonly tags?: readonly PluginTag[];
  /**
   * Optional dependency/conflict/provided-feature metadata used by plugin
   * selection UIs and future resolvers. Runtime execution semantics still
   * come from triggers, input.inject, and the scheduling declarations below.
   * Session-level resolution unions every runtime's declaration.
   */
  readonly relations?: PluginRelations;
  /** Plugin-data schemas, merged on namespace — a divergent one throws. */
  readonly dataSchemas?: Readonly<Record<string, PluginDataSchemaDecl>>;
  /** Domain events this plugin's runtime may emit via `emit-event`. */
  readonly events?: readonly PluginEventDecl[];
  /**
   * User-facing settings the plugin exposes in the Settings UI.
   * Each entry is auto-registered under `plugin.<pluginId>.<key>` in the
   * unified SettingsStore and rendered as a form field in the Plugins tab.
   *
   * See `PluginUserSettingSpec` for the allowed shape. Plugins read values
   * through their runtime context; the framework handles persistence. Because
   * the storage key is plugin-scoped, two runtimes declaring one key share a
   * single value and must declare it identically.
   */
  readonly userSettings?: readonly PluginUserSettingSpec[];
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

/**
 * Compile-time exhaustiveness: every key of {@link PluginScopedManifestFields}
 * must appear in {@link PLUGIN_SCOPED_FIELDS}, and vice versa. Adding a
 * plugin-scoped field without declaring how it merges breaks the build here.
 *
 * The assertion has to run through a constrained type parameter — a bare
 * conditional type alias just evaluates to its false branch and reports
 * nothing.
 */
type AssertTrue<T extends true> = T;

type _EveryScopedFieldDeclaresItsMerge = AssertTrue<
  keyof PluginScopedManifestFields extends keyof typeof PLUGIN_SCOPED_FIELDS
    ? true
    : false
>;
type _EveryRegisteredFieldExists = AssertTrue<
  keyof typeof PLUGIN_SCOPED_FIELDS extends keyof PluginScopedManifestFields
    ? true
    : false
>;

export interface RuntimeManifest extends PluginScopedManifestFields {
  readonly name: string;
  /**
   * Plugin ID this runtime belongs to.
   * For single-runtime plugins: same as `name`.
   * For multi-runtime plugins (name = "plugin/sub-runtime"): the part before `/`.
   * Set by the plugin loader during manifest parsing — not declared in PLUGIN.md.
   */
  readonly pluginId: string;
  readonly description: string;
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
   * Named scheduling stage. Required for `auto` / `scheduled` runtimes under
   * the strict authoring schema; forbidden for `event` / `manual`. Selects
   * the band the runtime runs in; order *within* the band comes from the
   * dependency edges below.
   */
  readonly stage?: import("./runtime-scheduling.js").Stage;
  /**
   * Weak ordering dependencies (pure ordering, no gate). Target failure or
   * absence never blocks this runtime.
   */
  readonly after?: readonly import("./runtime-scheduling.js").DependencyRef[];
  /**
   * Strong dependencies: ordering + gate. Each entry is a runtime id or a
   * `{ capability }` requirement. `scope: turn` (default) requires
   * same-execution success — when a required upstream ran with
   * `status !== 'success'`, or no in-scope capability provider succeeded, the
   * framework short-circuits this runtime with `status: 'skipped'` before the
   * guard / LLM pipeline, so downstream LLMs never run with empty inject
   * blocks. `scope: session` gates on the persistent snapshot frozen at
   * execution start (setup runtimes only).
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
   * Explicit read/write-set override for parallel hazard detection. Defaults
   * are derived from declared builtin tools / events / dataSchemas / ui /
   * outputKind; an explicit declaration is UNIONed with that derivation (it can
   * add, never remove). Consumed by `@covel/runtime`'s `schedule/effects.ts`;
   * same-layer hazards warn by default, `COVEL_EFFECTS_POLICY=strict` splits
   * conflicting pairs into serial sub-levels.
   */
  readonly effects?: import("./runtime-scheduling.js").EffectsDecl;
  /**
   * Declared permission upper bounds. `http` lists canonical HTTPS origins
   * (+ methods) this plugin may call through the Public Plugin API. Enforced
   * fail-closed for **community**-tier plugins by
   * `runtime/function-runtime/http-permissions.ts`; builtin / official are
   * trusted and pass through unchecked.
   */
  readonly permissions?: {
    readonly http?: readonly import("./runtime-scheduling.js").HttpPermissionDecl[];
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
