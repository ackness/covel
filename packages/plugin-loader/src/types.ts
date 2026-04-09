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
}

// ── Progressive loading results ──────────────────────────────────

/** Level 0: lightweight summary (loaded at framework startup). */
export interface PluginSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly pluginType: PluginType;
  readonly runtimeCount: number;
}

/**
 * Function handler context — passed to `runtimeType: 'function'` handlers.
 * The handler receives this context and returns a Record<string, unknown> output.
 */
export interface FunctionHandlerContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly playerMessage: string;
  readonly locale?: string;
  readonly store: unknown;
  readonly completedResults: ReadonlyMap<string, unknown>;
  readonly config: Readonly<Record<string, unknown>>;
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
  readonly manifest?: ParsedPluginMd;
  readonly loadedRuntimes: ReadonlyMap<string, LoadedRuntime>;
  readonly status: PluginEntryStatus;
  readonly error?: string;
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
