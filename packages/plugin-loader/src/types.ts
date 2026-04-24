/**
 * Plugin loader types — parsed results of PLUGIN.md files and references.
 */

import type { PluginType, RuntimeManifest } from '@covel/shared';

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

  generateImage(input: {
    readonly presetId?: string;
    readonly prompt: string;
    readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly images: readonly {
      readonly url?: string;
      readonly base64?: string;
      readonly mimeType?: string;
    }[];
    readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  }>;
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
  readonly store: unknown;
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
