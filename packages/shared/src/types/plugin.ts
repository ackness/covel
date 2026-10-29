/**
 * Plugin & Runtime manifest types.
 *
 * These types represent the parsed result of PLUGIN.md frontmatter.
 * All runtime configuration is defined via YAML frontmatter in PLUGIN.md files.
 */

import type { DataOpKind } from "@covel/plugin-handlers-utils";

/**
 * Runtime execution type.
 * - `agent` (default): LLM-driven with prompt template, tool calling, context assembly.
 * - `function`: Pure JS/TS function execution, no LLM call. Handler receives execution
 *   context and returns an output matching RuntimeResult directly.
 */
export type RuntimeType = "agent" | "function";

/**
 * Bounded prompt history for an agent runtime. `maxTurns` keeps the newest N
 * turns of visible history (0 = none) and drops compaction summaries, so the
 * prompt no longer grows with the session.
 */
export interface RuntimeHistoryPolicy {
  /** Retain persisted summaries alongside the bounded raw history. */
  readonly includeSummaries?: boolean;
  readonly maxTurns: number;
}

// ── Trigger system ───────────────────────────────────────────────

/**
 * Runtime trigger modes.
 *
 * The three production modes (values outside the enum are rejected at load):
 * - `auto`   — every turn of its stage, or every `every`-th logical turn.
 * - `manual` — only on an explicit `POST /plugin-rpc` request.
 * - `event`  — when a subscribed `topic` is emitted within the turn's
 *              event fan-out (see `turn-event-chain.ts`).
 */
export type TriggerType = "auto" | "manual" | "event";

export interface TriggerConfig {
  readonly type: TriggerType;
  /**
   * `auto` only: run on the logical turns that are a multiple of this
   * number. Authored as `schedule.every`; defaults to 1 (every turn).
   */
  readonly every?: number;
  /** Event topic for `event` mode. */
  readonly topic?: string;
  /** Max trigger count within a session. */
  readonly maxTriggerCount?: number;
  /** Min turns between two triggers. */
  readonly cooldownTurns?: number;
  /**
   * First main-loop turn at which this runtime may trigger. Optional —
   * when unset the runtime triggers as soon as its stage opens.
   * Compared against the logical turn (`completedPlayerTurns + 1`).
   */
  readonly startTurn?: number;
}

// ── Turn completion policy ────────────────────────────────────────

/** Whether a staged runtime participates in the foreground turn barrier. */
export type TurnCompletionMode = "await" | "detached";

/**
 * Turn-barrier policy of a staged runtime, compiled from the author's
 * `schedule.detached`. `detached` lets the foreground turn complete after
 * this runtime has been durably queued; it does not change manual/event
 * activation, which uses {@link RuntimeManifest.execution}. Jobs of one
 * runtime run one at a time in source-turn order, and a job whose session
 * moved on does not commit.
 */
export interface TurnCompletionConfig {
  readonly mode?: TurnCompletionMode;
  /** The next execution waits for the job, for at most `maxSettleWaitMs`. */
  readonly settle?: boolean;
  readonly maxSettleWaitMs?: number;
  /** Maximum time the job may remain queued before it expires. */
  readonly maxQueueMs?: number;
  /** Maximum time a claimed detached execution may run before it expires. */
  readonly maxExecutionMs?: number;
}

// ── Input declarations ───────────────────────────────────────────

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

export interface KernelInjectDecl {
  readonly kind: "kernel";
  readonly from: "turn-digest@1";
  readonly name: string;
}

export type InputInjectDecl =
  PluginDataInjectDecl | RuntimeExportInjectDecl | KernelInjectDecl;

export interface InputConfig {
  /**
   * Runtime-dir-relative JSON Schema path validating this runtime's
   * activation payload (manual RPC payload / event payload). Function and
   * agent runtimes consume the same validated canonical payload; enforced
   * on `RuntimeActivation.payload` before dispatch.
   */
  readonly schema?: string;
  readonly inject?: readonly InputInjectDecl[];
}

// ── Output declarations ──────────────────────────────────────────

/**
 * How the framework treats this runtime's output.
 * - `story` — main narrative content, shown in the chat stream.
 * - `system` (default) — everything else; its free text is not shown to the
 *   player.
 */
export type OutputKind = "story" | "system";

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

// ── Plugin datasets ─────────────────────────────────────────────

/** Compiled `contributes.datasets.<name>` with defaults resolved. */
export interface PluginDatasetDecl {
  /** Plugin-data namespace; equals the dataset name. */
  readonly namespace: string;
  /** Plugin-relative path to the JSON Schema every record must satisfy. */
  readonly schema: string;
  /** Top-level record field whose string value is the record's key. */
  readonly key?: string;
  /** Operation kinds allowed on the dataset; every kind when undeclared. */
  readonly ops: readonly DataOpKind[];
}

// ── World projections ─────────────────────────────────────

/** One plugin-data destination produced by a world projection. */
export interface WorldProjectionOutputDecl {
  /** Plugin-owned destination namespace. */
  readonly namespace: string;
  /** Field in each projected record used as its plugin-data key. */
  readonly key: string;
}

/**
 * Plugin-owned projection from one declared world schema into plugin data.
 * `handler` is metadata at manifest/registry time; loading or executing the
 * module is the responsibility of the world-projection runner.
 */
export interface WorldProjectionDecl {
  /** Source schema URI, for example `plugin://character-blueprint/blueprints`. */
  readonly from: string;
  /** Plugin-root-relative JavaScript handler module. */
  readonly handler: string;
  /** Named plugin-data destinations produced by the handler. */
  readonly outputs: Readonly<Record<string, WorldProjectionOutputDecl>>;
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
 * (`scene-stage`) or `pluginId/runtimeId` — EXCEPT under `provides`, where the
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
  // Optional: a setting may declare no default. Mirrors the
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
// keep importing them from the same place.
export { HOOK_EVENTS } from "./hooks.js";
export type { HookEventName, HookEnforce, HookDeclaration } from "./hooks.js";

// ── UI declarations ─────────────────────────────────────────────

/**
 * UI slot type — where plugin UI contributions appear in the frontend.
 * - `right`: Right sidebar panel tabs (status panels, dashboards)
 * - `message`: Inline blocks in the chat message area
 * - `view`: Full-column pages replacing the story column
 */
export type UISlotType = "right" | "message" | "view";

/**
 * UI contribution spec — declares which JSON files a plugin contributes
 * to each UI slot. Mirrors the tools declaration pattern.
 *
 * Paths are relative to the package root directory.
 * Each JSON spec declares a catalog view or a sandboxed HTML webview.
 */
export interface UISpec {
  /** Right sidebar panel specs. */
  readonly right?: readonly string[];
  /** Message area block specs. */
  readonly message?: readonly string[];
  /** Full-column view specs. */
  readonly view?: readonly string[];
}

// ── Slash commands ──────────────────────────────────────────────

/** Optional, server-authored environment facets a command handler may read. */
export const SLASH_COMMAND_CONTEXT_SCOPES = [
  "session",
  "active-runtimes",
  "models",
] as const;

export type SlashCommandContextScope =
  (typeof SLASH_COMMAND_CONTEXT_SCOPES)[number];

export type SlashCommandArgumentType =
  "string" | "integer" | "number" | "boolean";

/** One positional argument in a plugin-declared slash command. */
export interface SlashCommandArgumentSpec {
  readonly name: string;
  readonly type?: SlashCommandArgumentType;
  readonly description?: import("./world.js").I18nText;
  readonly required?: boolean;
  /** Collect all remaining argv values. Must be the last argument. */
  readonly variadic?: boolean;
  readonly choices?: readonly string[];
}

/**
 * Player-facing command metadata declared by a plugin manifest.
 *
 * `action` names an RPC handler registered by the SAME plugin entry. The
 * framework injects the owning plugin id; a manifest cannot dispatch into a
 * different plugin or an arbitrary client function. Optional environment
 * context is least-privilege and server-authored at execution time.
 */
export interface SlashCommandSpec {
  /** Lowercase command name without the leading slash. */
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: import("./world.js").I18nText;
  readonly arguments?: readonly SlashCommandArgumentSpec[];
  readonly action: string;
  /** Extra environment facets to inject. Omitted means no environment snapshot. */
  readonly context?: readonly SlashCommandContextScope[];
}

/** Session-scoped command descriptor returned to the client. */
export interface SessionSlashCommand extends SlashCommandSpec {
  /** Stable dispatch id. Framework commands use `framework:<name>`. */
  readonly id: string;
  readonly pluginId: string;
  readonly source: "framework" | "plugin";
  readonly sourceLabel?: import("./world.js").I18nText;
}

/** Parsed, type-coerced invocation passed to the registered RPC handler. */
export interface SlashCommandInvocation {
  readonly command: string;
  /** Canonical command text built from the resolved command name and typed args. */
  readonly canonical: string;
  /** Original composer text, or `canonical` for a structured UI invocation. */
  readonly raw: string;
  readonly argv: readonly string[];
  readonly args: Readonly<Record<string, unknown>>;
}

// ── Runtime manifest ─────────────────────────────────────────────

// ── Plugin-scoped manifest fields ────────────────────────────────

/** Root-owned contribution fields in the compiled execution record. */
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
  /**
   * Model slot. The loader gives an agent that names none the slot of its
   * visibility (`story` → `story`, otherwise `plugin`); see
   * `defaultAgentModel` in `@covel/shared`.
   */
  readonly model?: string;
  /** Per-call preferences; explicit slot/preset reasoning settings take priority. */
  readonly llm?: import("./llm-adapter.js").LLMRequestDefaults;
  /**
   * Prior conversation an agent runtime sees. Omitted means the shared
   * session view (uncompacted history plus compaction summaries).
   */
  readonly history?: RuntimeHistoryPolicy;
  /**
   * Per-runtime hard timeout in ms.
   * Overrides the executor default for agent runtimes. The loader fills the
   * authored default of an agent (`AGENT_LOOP_DEFAULTS` in `@covel/shared`);
   * the fallbacks described on these fields apply to a manifest built
   * without the loader.
   */
  readonly timeoutMs?: number;
  /**
   * Per-runtime cap on the agent tool-call loop. Overrides the framework
   * default (20). Each step is one model response, potentially containing
   * multiple tool calls. Use completeAfterTools for early success; explicit
   * lower budgets remain available for constrained runtimes.
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
   * Total timeout of one non-streaming LLM call in ms. Caps a single provider
   * call so a hung request cannot consume the whole `timeoutMs` budget.
   * Defaults to `min(60000, floor(timeoutMs / (maxRetries + 1)))` so every
   * retry attempt fits inside the runtime deadline. A streaming call is
   * limited by `firstTokenTimeoutMs` and `idleTimeoutMs` instead.
   */
  readonly callTimeoutMs?: number;
  /**
   * Streaming first-token (TTFB) timeout in ms. Fires when a streaming LLM
   * call is established but emits no text, reasoning or tool-call event
   * before the threshold — typical symptom of a hung provider with a live TCP
   * socket. Ignored for non-streaming calls.
   *
   * A value set here is the wait of every attempt. Without one, an attempt
   * waits at most 120000 and no longer than leaves room, inside what is left
   * of `timeoutMs`, for the retries `maxRetries` still allows: the last
   * attempt may wait for all that is left, an earlier one for its equal
   * share or 60000 when the share is shorter, never more than half. Set it
   * for a model whose first output takes longer than that.
   */
  readonly firstTokenTimeoutMs?: number;
  /**
   * Longest silence, in ms, of a streaming LLM call that has started to
   * write. Each output starts the wait again, so a model that keeps writing
   * is not cut off and the time it writes does not count against `timeoutMs`.
   * Default 120000. Ignored for non-streaming calls.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Tool-call loop detection threshold. When the LLM emits `N` consecutive
   * tool calls with identical `{name, arguments}`, the executor aborts the
   * current attempt and retries (with perturbation) to break the loop.
   * Default 3. Set to 0 to disable loop detection.
   */
  readonly loopDetectionThreshold?: number;
  /**
   * Agent runtimes only. Requires a successful completeAfterTools call;
   * without that list, any successful business tool counts. Failed calls and
   * runtime-done do not count. A text finish without this evidence gets one
   * corrective retry, then fails. The same rule applies after resume and at
   * every loop exit. Default false.
   */
  readonly requireToolUse?: boolean;
  /**
   * Require a successful completeAfterTools call or an explicit runtime-done
   * no-op. Bare text is corrected once, then fails. Unlike requireToolUse,
   * this preserves the no-change path; read tools alone do not complete work.
   */
  readonly requireExplicitCompletion?: boolean;
  /**
   * Agent runtimes only. Tool names whose successful execution completes the
   * runtime after the current response batch. All calls in that response are
   * executed first; any failed business call keeps the loop alive so the model
   * can inspect the error and retry. This removes a redundant follow-up LLM
   * call whose only purpose is to emit `runtime-done` while preserving read →
   * write workflows that use other tools first.
   */
  readonly completeAfterTools?: readonly string[];
  /**
   * Maximum nested `ctx.recursiveCall()` depth for this runtime. Defaults
   * to the executor limit, currently 10. Depth starts at 0 for a top-level
   * turn and increments once per recursive call.
   */
  readonly maxRecursionDepth?: number;
  /**
   * How the framework treats this runtime's output in the UI.
   * Defaults to `'system'`. Only `'story'` outputs are shown in the main chat stream.
   */
  readonly outputKind?: OutputKind;
  /**
   * The runtime handles content that must stay hidden from the player (for
   * example hidden story events). Its LLM messages, tool arguments, tool
   * results, and outputs are stripped from traces, the live stream, and
   * player-facing execution history; status, timing, and usage remain.
   */
  readonly concealed?: boolean;
  readonly outputContract?: string;
  readonly defaultProvider?: boolean;
  /**
   * Named scheduling stage. Required for `auto` runtimes under
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
   * `runtime/function-runtime/http-permissions.ts`; builtin plugins are
   * trusted and pass through unchecked.
   */
  readonly permissions?: {
    readonly http?: readonly import("./runtime-scheduling.js").HttpPermissionDecl[];
  };
  readonly trigger?: TriggerConfig;
  /**
   * Execution mode when this runtime is activated via a manual plugin-rpc call
   * or as an event-chain follower.
   *
   * - `'sync'` (default): caller awaits runtime completion; proposals commit
   *   inside the request/response cycle.
   * - `'background'`: server queues a durable runtime job and returns its
   *   `jobId` at once; status streams as `job-status.updated` and
   *   `_runtime_jobs` plugin-data changes.
   *
   * Ignored for runtimes triggered by the normal per-turn scheduler.
   */
  readonly execution?: "sync" | "background";
  /**
   * Controls whether a scheduler-driven runtime blocks foreground turn
   * completion. Defaults to `{ mode: 'await' }`. The loader currently permits
   * `detached` only for `post-turn` / `audit` runtimes whose output is not
   * `story`; cross-runtime DAG eligibility is validated by the scheduler.
   */
  readonly turnCompletion?: TurnCompletionConfig;
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
  /**
   * The package's player settings, copied onto each runtime by the loader so
   * `ctx.userSettings` resolves without the package declaration.
   */
  readonly userSettings?: readonly PluginUserSettingSpec[];
  /** The package's plugin-data schemas, copied onto each runtime by the loader. */
  readonly dataSchemas?: Readonly<Record<string, PluginDataSchemaDecl>>;
  /** The package's datasets keyed by namespace, copied onto each runtime by the loader. */
  readonly datasets?: Readonly<Record<string, PluginDatasetDecl>>;
}
