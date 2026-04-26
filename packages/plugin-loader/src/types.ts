/**
 * Plugin loader types — parsed results of PLUGIN.md files and references.
 */

import type { MediaRef, PluginType, RuntimeManifest, TurnInput, TurnResult } from '@covel/shared';

// ── Parsed PLUGIN.md ─────────────────────────────────────────────

export interface ParsedPluginMd {
  /** Validated manifest from YAML frontmatter. */
  readonly manifest: RuntimeManifest;
  /** Markdown body (un-interpolated prompt template). */
  readonly promptTemplate: string;
  /** Reference file paths extracted from markdown links. */
  readonly referenceLinks: readonly string[];
  /** Raw frontmatter object (before validation). */
  readonly rawFrontmatter: Readonly<Record<string, unknown>>;
}

// ── Parsed reference ─────────────────────────────────────────────

export interface ParsedReference {
  /** File path of the reference. */
  readonly filePath: string;
  /** Trigger keywords from frontmatter. */
  readonly keywords: readonly string[];
  /** Markdown content body. */
  readonly content: string;
}

// ── Plugin discovery ─────────────────────────────────────────────

export interface PluginDiscoveryResult {
  /** Plugin ID (directory name). */
  readonly id: string;
  /** Plugin root directory path. */
  readonly rootPath: string;
  /** Whether this is a multi-runtime plugin. */
  readonly isMultiRuntime: boolean;
  /** Discovered PLUGIN.md file paths. */
  readonly pluginMdPaths: readonly string[];
  /**
   * Optional pre-classified trust source. When set this overrides
   * prefix-based detection in `getPluginTrustInfo`. `discoverPluginsMulti`
   * tags plugins outside the first (bundled) directory as `'community'`
   * regardless of id, so a user-supplied `core-evil` cannot auto-load.
   */
  readonly source?: PluginSource;
}

// ── Progressive loading results ──────────────────────────────────

/** I18n text: plain string or locale map (e.g. { "zh-CN": "...", "en-US": "..." }). */
export type I18nText = string | Readonly<Record<string, string>>;

/** Level 0: lightweight summary (loaded at framework startup). */
export interface PluginSummary {
  readonly id: string;
  readonly name: I18nText;
  readonly description: I18nText;
  readonly pluginType: PluginType;
  readonly runtimeCount: number;
}

/**
 * Minimal gateway facade exposed to function-runtime handlers and guards.
 *
 * This is a narrow, structural projection of `@covel/ai-provider`'s full
 * `Gateway` surface. Only the calls plugins actually need are exposed —
 * `generateText` (chat completions), `generateObject` (structured output)
 * and `generateImage` (image generation). Streaming / embeddings / speech /
 * transcription are intentionally absent; if a plugin truly needs them it
 * should declare an agent runtime and use the kernel's LLM pipeline via
 * manifest `input.inject`.
 *
 * `presetId` is a slot name (e.g. `default`, `image`, `fast`). `undefined`
 * resolves to the framework default for the relevant modality. API keys /
 * slot overrides remain request-scoped — the server wires them up when it
 * constructs the adapter; plugins never deal with them directly.
 *
 * The interface is deliberately structural (no class, no branded types) to
 * avoid a circular dep between `@covel/plugin-loader` and `@covel/ai-provider`.
 */
export interface PluginRuntimeGateway {
  generateText(input: {
    readonly presetId?: string;
    readonly prompt?: string;
    readonly system?: string;
    readonly messages?: readonly {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
    }[];
    readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly text: string;
    readonly finishReason: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  }>;

  generateObject<T = unknown>(input: {
    readonly presetId?: string;
    readonly schema: Readonly<Record<string, unknown>>;
    readonly prompt?: string;
    readonly system?: string;
    readonly messages?: readonly {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
    }[];
    readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly object: T;
    readonly finishReason: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  }>;

  /**
   * Resolve a slot/preset id into its public configuration view. Returns
   * `null` when no slot can be resolved (typical when llm.toml is empty).
   *
   * Use this when your plugin owns the wire format (image generators,
   * audio, custom HTTP-based providers). The framework still picks the
   * right preset, applies request-scoped key/url overrides, and hands
   * back `{ baseUrl, apiKey, model, metadata, … }` — your handler then
   * uses any SDK or raw fetch you like.
   *
   * Prefer this over `generateImage`/`embed` when you need wire-level
   * control (custom polling, novel response shape, vendor-specific
   * params). The high-level helpers stay for the most common cases.
   */
  resolveSlot(input: {
    readonly presetId?: string;
    /** Defaults to "text"; pass "image" / "embedding" / "speech" / "transcription" for non-text slots. */
    readonly fallbackTag?: string;
  }): ResolvedSlotForPlugin | null;
}

/**
 * Plugin-facing projection of `@covel/ai-provider`'s `ResolvedSlotConfig`.
 * Same shape, redeclared here so this package keeps zero dep on
 * @covel/ai-provider (avoids circular dep with @covel/runtime).
 */
export interface ResolvedSlotForPlugin {
  readonly presetId: string;
  readonly provider: string;
  readonly protocol: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly model: string;
  readonly tag: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Narrow utility surface exposed to plugin function handlers via
 * `FunctionHandlerContext.utils`. Plugins use these to enforce the same
 * SSRF policy and retry semantics the framework's own adapters use,
 * without re-implementing them.
 *
 * Structural type: kept free of `@covel/ai-provider` imports so
 * `@covel/plugin-loader` stays at the bottom of the dep graph. The
 * runtime wires actual implementations from `@covel/ai-provider/plugin-utils`.
 */
export interface PluginRuntimeUtils {
  /**
   * SSRF-safe URL check. Returns `{ ok: true }` for safe URLs and
   * `{ ok: false, reason }` with a human-readable explanation for
   * blocked ones (private IPs, cloud metadata hosts, non-loopback http).
   */
  validateBaseUrl(url: string): { readonly ok: boolean; readonly reason?: string };

  /**
   * fetch with exponential-backoff retry on 429 / 5xx. Honors `Retry-After`.
   * Does NOT retry on thrown fetch errors (DNS / network). Default
   * `maxRetries: 3`; pass 0 to disable.
   */
  fetchWithRetry(
    input: string | URL,
    init?: RequestInit & {
      readonly maxRetries?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<Response>;
}

export interface IngestUrlOptions {
  /** Maximum response bytes accepted before the download is aborted. */
  readonly maxBytes?: number;
  /** End-to-end timeout for the ingest request, including redirects. */
  readonly timeoutMs?: number;
  /** MIME allow-list. Supports exact matches and family wildcards such as `image/*`. */
  readonly allowedMimes?: readonly string[];
  /** Abort signal forwarded from the handler or turn runtime. */
  readonly signal?: AbortSignal;
  /** Additional metadata persisted with the media object. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface MediaContext {
  put(
    blob: Uint8Array | Blob,
    mime: string,
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  resolveUrl(ref: MediaRef): Promise<string>;
  ingestUrl(url: string, opts?: IngestUrlOptions): Promise<MediaRef>;
}

/**
 * Function handler context — passed to `runtimeType: 'function'` handlers.
 * The handler receives this context and returns a Record<string, unknown> output.
 */
export interface FunctionHandlerContext {
  readonly sessionId: string;
  readonly turnId: string;
  /** Plugin ID this handler belongs to (derived from manifest). */
  readonly pluginId: string;
  readonly playerMessage: string;
  readonly locale?: string;
  /**
   * Store handle exposed to the runtime. Community plugins receive a
   * narrow `FunctionStoreView` that only allows scoped reads — broader
   * mutations must go through `ctx.pluginData` or the handler's return
   * value (proposal pipeline). Core plugins receive the full `DataStore`
   * (typed as `unknown` here to keep this package free of a
   * @covel/store import) because they implement framework primitives.
   * The runtime decides which to inject based on `manifest.pluginType`.
   */
  readonly store: FunctionStoreView | unknown;
  readonly completedResults: ReadonlyMap<string, unknown>;
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * Optional gateway facade for function runtimes that need LLM / image /
   * structured-object generation. Absent when the executor was constructed
   * without a `gateway` dep (e.g. test harnesses). Handlers must null-check
   * before use and surface a clear error when the dep is missing rather
   * than assuming availability.
   */
  readonly gateway?: PluginRuntimeGateway;
  /**
   * Vetted utility helpers (SSRF guard + retrying fetch). Always present
   * in production — only absent in test harnesses constructed without
   * `utils` wired. Plugins that own their own wire format should prefer
   * `utils.fetchWithRetry` over bare `fetch` and gate every user-supplied
   * URL through `utils.validateBaseUrl` before calling it.
   */
  readonly utils?: PluginRuntimeUtils;
  /**
   * Media storage primitives for function runtimes. Present when the
   * runtime is wired with a MediaStore. `ingestUrl` applies the framework
   * SSRF, redirect, timeout, byte budget, and MIME validation policy before
   * persisting bytes.
   */
  readonly media?: MediaContext;
  /** Run a nested turn with a partial input override. Depth is bounded by runtime governance. */
  readonly recursiveCall: (
    delta: Partial<TurnInput>,
    opts?: { readonly reason?: string },
  ) => Promise<TurnResult>;
  /** Current recursiveCall depth. Top-level runtime executions start at 0. */
  readonly recursionDepth: number;
  /**
   * Optional manual-trigger payload — only populated when the turn was
   * initiated via `POST /api/sessions/:id/plugin-rpc` with a `runtimeId`
   * targeting this runtime. Normal auto/scheduled/event runs leave it
   * undefined, so handlers can branch on presence to pick up click-time
   * context (selected character, user input, etc.).
   */
  readonly manualPayload?: Readonly<Record<string, unknown>>;
  /**
   * Optional trigger-event descriptor — only populated when this runtime
   * was activated by the in-turn event chain (an earlier runtime in the
   * same turn emitted `output.events: [{ topic, data }]` matching this
   * runtime's `trigger: { type: 'event', topic }`). Absent for manual,
   * scheduled, and auto-trigger activations.
   */
  readonly triggerEvent?: {
    readonly topic: string;
    readonly data: Readonly<Record<string, unknown>>;
  };
  /**
   * Resolved player-authored plugin settings for THIS plugin, with
   * `manifest.userSettings[].default` applied for any key the player
   * hasn't overridden (audit F7). Every key declared in the manifest is
   * guaranteed to be present. Absent when no `userSettings` were declared
   * — callers don't need to defensively read it in that case.
   *
   * Scoped to the runtime's own pluginId — a plugin cannot observe
   * another plugin's settings through this channel.
   */
  readonly userSettings?: Readonly<Record<string, unknown>>;
  /**
   * Scoped plugin-data writer. Writes bypass the proposal system and land
   * directly in `plugin_data` rows under the runtime's own `pluginId`, so
   * handlers can publish interim placeholders (e.g. a pending image frame
   * before DashScope responds) that the frontend can observe via SSE
   * `plugin-data.changed`. Absent when the executor was constructed
   * without a `store` dep (test harnesses).
   */
  readonly pluginData?: PluginDataWriter;
  /**
   * Per-runtime logger. Every call appends a row in the plugin's `_logs`
   * namespace so plugin-authored diagnostics survive restarts and can be
   * inspected from `/api/sessions/:id/plugin-data/:pluginId/_logs`.
   * Absent in test harnesses without a store.
   */
  readonly logger?: PluginLogger;
}

/**
 * Narrow read-only view of `DataStore` exposed to community function
 * runtimes via `FunctionHandlerContext.store` (audit P0-3). Replaces the
 * historical "the-whole-DataStore" exposure which let third-party
 * plugins bypass proposal/tool governance and write into any other
 * plugin's data through `setPluginData(...)`.
 *
 * Core / official plugins (`pluginType: 'core-plugin'`) keep the full
 * `DataStore` because they implement framework primitives that need it
 * (e.g. `core-world-init`'s guard imports historic sessions, `core-
 * char-creator`'s guard upserts the player Character record). The
 * runtime decides which surface to inject based on the manifest's
 * trust signal.
 *
 * Plugins that want to write data should use `ctx.pluginData.set(...)`
 * (placeholders) or return `{ pluginData: [...] }` from the handler so
 * the proposal / commit pipeline runs.
 */
export interface FunctionStoreView {
  /** Read a single plugin_data row scoped to the calling plugin. */
  getPluginData(
    namespace: string,
    key: string,
  ): Promise<{ readonly key: string; readonly value: unknown } | null>;
  /** List every plugin_data row in a namespace scoped to the calling plugin. */
  listPluginData(
    namespace: string,
  ): Promise<ReadonlyArray<{ readonly key: string; readonly value: unknown }>>;
  /** Read the canonical session record. */
  getSession(): Promise<unknown>;
  /** List recent turn messages for the session (read-only timeline access). */
  listTurnMessages(limit?: number): Promise<unknown[]>;
}

/**
 * Handler-facing wrapper over `DataStore.setPluginData` scoped to the
 * active session + plugin. Callers cannot write to another plugin's
 * namespace through this handle — the kernel binds `pluginId`.
 */
export interface PluginDataWriter {
  /**
   * Upsert a single plugin_data row. When `value === null`, the row is
   * deleted — matches the generic "set-or-delete" pattern other kernel
   * writers use.
   */
  set(namespace: string, key: string, value: unknown): Promise<void>;
  /** Read the current value for a key (returns `null` when absent). */
  get(namespace: string, key: string): Promise<unknown>;
  /** List every entry in a namespace, newest first per store ordering. */
  list(namespace: string): Promise<ReadonlyArray<{ readonly key: string; readonly value: unknown }>>;
  /** Delete a row explicitly. */
  delete(namespace: string, key: string): Promise<void>;
}

/**
 * Structured logger exposed to plugin handlers. Each call appends a new
 * row under the plugin's `_logs` namespace keyed by timestamp+uuid so
 * entries are append-only and naturally ordered.
 */
export interface PluginLogger {
  debug(message: string, meta?: Record<string, unknown>): Promise<void>;
  info(message: string, meta?: Record<string, unknown>): Promise<void>;
  warn(message: string, meta?: Record<string, unknown>): Promise<void>;
  error(message: string, meta?: Record<string, unknown>): Promise<void>;
}

/** Function handler signature for `runtimeType: 'function'` runtimes. */
export type FunctionHandler = (ctx: FunctionHandlerContext) => Promise<Record<string, unknown>>;

/** Level 2: fully loaded runtime ready for execution. */
export interface LoadedRuntime {
  readonly manifest: RuntimeManifest;
  readonly promptTemplate: string;
  readonly references: readonly ParsedReference[];
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Handler function for `runtimeType: 'function'` runtimes. */
  readonly handler?: FunctionHandler;
  /** Guard function — runs before agent execution, returns `{ skip: true }` to bypass LLM. */
  readonly guard?: FunctionHandler;
  /** Loaded UI specs from ui/ directory, grouped by slot. */
  readonly uiSpecs?: {
    readonly right?: readonly Readonly<Record<string, unknown>>[];
    readonly message?: readonly Readonly<Record<string, unknown>>[];
    readonly left?: readonly Readonly<Record<string, unknown>>[];
  };
}

// ── Plugin registry ──────────────────────────────────────────────

export type PluginEntryStatus =
  | 'discovered'
  | 'registered'
  | 'active'
  | 'disabled'
  | 'error';

export interface PluginRegistryEntry {
  readonly id: string;
  readonly summary: PluginSummary;
  /** Primary manifest (first runtime). */
  readonly manifest?: ParsedPluginMd;
  /** All manifests for multi-runtime plugins. */
  readonly manifests?: readonly ParsedPluginMd[];
  readonly loadedRuntimes: ReadonlyMap<string, LoadedRuntime>;
  readonly status: PluginEntryStatus;
  readonly error?: string;
  /**
   * Discovery-source trust. Set by bootstrap from
   * `PluginDiscoveryResult.source` so downstream trust decisions (runtime RPC
   * approval gate, tool trust clamp, auto-load) use the path the plugin was
   * discovered from, not a `pluginType` field the plugin itself can forge.
   *
   * When absent, callers fall back to id-prefix detection via
   * `getPluginTrustInfo(pluginId)` — `core-*` → builtin, everything else →
   * community.
   */
  readonly source?: PluginSource;
}

export type RegistryChangeEvent =
  | { readonly type: 'plugin-registered'; readonly pluginId: string }
  | { readonly type: 'plugin-activated'; readonly pluginId: string; readonly sessionId: string }
  | { readonly type: 'plugin-deactivated'; readonly pluginId: string; readonly sessionId: string }
  | { readonly type: 'plugin-reloaded'; readonly pluginId: string }
  | { readonly type: 'plugin-error'; readonly pluginId: string; readonly error: string };

// ── Plugin trust ─────────────────────────────────────────────────

export type PluginSource = 'builtin' | 'official' | 'community';

export interface PluginTrustInfo {
  readonly source: PluginSource;
  readonly requiresApproval: boolean;
  readonly autoLoad: boolean;
}
