/**
 * Plugin loader types — parsed results of PLUGIN.md files.
 */

import type { LoadedRuntime, PluginSource } from "@covel/shared/plugin-runtime";
export type {
  PluginRuntimeGateway,
  ResolvedSlotForPlugin,
  PluginRuntimeUtils,
  IngestUrlOptions,
  MediaContext,
  ImageGenerateInput,
  ImageGenerateOutput,
  ImagesContext,
  SpeechGenerateInput,
  SpeechGenerateOutput,
  SpeechTranscribeInput,
  SpeechContext,
  AssetProgressInput,
  FunctionHandlerContext,
  FunctionStoreView,
  PluginDataWriter,
  PluginLogger,
  ProgressEffect,
  ProgressReporter,
  FunctionHandler,
  AgentGuardResult,
  AgentGuard,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";

import type {
  PluginDataSchemaDecl,
  WorldProjectionDecl,
  PluginRelations,
  PluginTag,
  PluginType,
  RuntimeManifest,
} from "@covel/shared";

// ── Parsed PLUGIN.md ─────────────────────────────────────────────

export interface ParsedPluginMd {
  /** Validated manifest from YAML frontmatter. */
  readonly manifest: RuntimeManifest;
  /** Markdown body (un-interpolated prompt template). */
  readonly promptTemplate: string;
  /** Raw frontmatter object (before validation). */
  readonly rawFrontmatter: Readonly<Record<string, unknown>>;
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

/**
 * Declaration-time server entry definition for one plugin package.
 *
 * This is metadata only: `entryPaths` are validated manifest declarations and
 * no plugin module has been imported. Keeping this separate from
 * {@link LoadedRuntime} prevents discovery/approval decisions from depending on
 * which executable runtime artifacts happen to be loaded.
 */
export interface PluginEntryDefinition {
  readonly pluginId: string;
  readonly pluginRoot: string;
  /** Plugin-root-relative entry module paths, deduplicated in declaration order. */
  readonly entryPaths: readonly string[];
  /** Non-fatal parse issue for a metadata-only multi-runtime root manifest. */
  readonly rootManifestIssue?: {
    readonly path: string;
    readonly message: string;
  };
}

// ── Progressive loading results ──────────────────────────────────

/** I18n text: plain string or locale map (e.g. { "zh-CN": "...", "en-US": "..." }). */
export type I18nText = string | Readonly<Record<string, string>>;

/** Level 0: lightweight summary (loaded at framework startup). */
export interface PluginSummary {
  readonly id: string;
  readonly name: I18nText;
  /**
   * Friendly, player-facing name (I18nText) from the `displayName` frontmatter
   * field. Falls back to `name`/`id` at the UI layer when absent. Lets plugin
   * lists show e.g. "行动引导 / Action Guide" instead of the raw id "guide".
   */
  readonly displayName?: I18nText;
  readonly description: I18nText;
  readonly pluginType: PluginType;
  readonly runtimeCount: number;
  readonly tags?: readonly PluginTag[];
  readonly relations?: PluginRelations;
}

// ── Plugin registry ──────────────────────────────────────────────

export type PluginEntryStatus =
  "discovered" | "registered" | "active" | "disabled" | "error";

export interface PluginRegistryEntry {
  readonly id: string;
  readonly summary: PluginSummary;
  /** Absolute plugin root path, used by tooling that resolves plugin-relative assets. */
  readonly rootPath?: string;
  /** Discovery-time absolute PLUGIN.md paths keyed by declared runtime ID. */
  readonly runtimeManifestPaths?: Readonly<Record<string, string>>;
  /** Primary manifest (first runtime). */
  readonly manifest?: ParsedPluginMd;
  /** All manifests for multi-runtime plugins. */
  readonly manifests?: readonly ParsedPluginMd[];
  /** Plugin-level data schema declarations merged across all runtime manifests. */
  readonly dataSchemas?: Readonly<Record<string, PluginDataSchemaDecl>>;
  /** Plugin-level world projections merged across all runtime manifests. */
  readonly worldProjections?: Readonly<Record<string, WorldProjectionDecl>>;
  /**
   * Executable artifacts loaded on demand.
   * Declaration-time discovery must use `manifests`, never this partial cache.
   */
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
  | { readonly type: "plugin-registered"; readonly pluginId: string }
  | {
      readonly type: "plugin-activated";
      readonly pluginId: string;
      readonly sessionId: string;
    }
  | {
      readonly type: "plugin-deactivated";
      readonly pluginId: string;
      readonly sessionId: string;
    }
  | { readonly type: "plugin-reloaded"; readonly pluginId: string }
  | {
      readonly type: "plugin-error";
      readonly pluginId: string;
      readonly error: string;
    };

// ── Plugin trust ─────────────────────────────────────────────────

export type { PluginSource } from "@covel/shared/plugin-runtime";

export interface PluginTrustInfo {
  readonly source: PluginSource;
  readonly requiresApproval: boolean;
  readonly autoLoad: boolean;
}
