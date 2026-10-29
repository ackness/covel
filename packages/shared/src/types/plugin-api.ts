import type { DefaultViewMode } from "../schemas/view-mode.js";
/** Canonical HTTP DTOs for plugin discovery and session plugin state. */

import type { EffectiveTurnCompletion } from "../scheduling/normalize.js";
import type {
  DependencyRef,
  EffectResource,
  Stage,
} from "./runtime-scheduling.js";
import type { PluginUserSettingSpec, SessionSlashCommand } from "./plugin.js";
import type { I18nText } from "./world.js";
import type { PackageAuthor } from "../schemas/package-info.js";

export type PluginSource = "builtin" | "community";

export type PluginStatus =
  "discovered" | "registered" | "active" | "disabled" | "error";

export interface PluginRuntimeTrigger {
  readonly type: "auto" | "manual" | "event";
  readonly every?: number;
  readonly cooldownTurns?: number;
  readonly maxTriggerCount?: number;
  readonly startTurn?: number;
  readonly topic?: string;
}

export interface PluginRuntimeSummary {
  readonly id: string;
  readonly runtimeType: "agent" | "function";
  readonly stage?: Stage;
  readonly trigger: PluginRuntimeTrigger;
  readonly execution: "sync" | "background";
  readonly turnCompletion: EffectiveTurnCompletion;
  /** Runs only as a sub-agent of another runtime; no manual run starts it. */
  readonly subagentOnly?: true;
  readonly model?: string;
  readonly outputKind: "story" | "system";
  readonly outputContract?: string;
}

export interface PluginToolSummary {
  readonly id: string;
  readonly kind: "builtin" | "local";
  readonly runtimeId?: string;
}

/** Non-fatal load warnings. Paths are relative to the plugin root. */
export interface PluginLoadDiagnostics {
  readonly disabledRuntimes?: readonly {
    readonly sourcePath: string;
    readonly message: string;
    readonly outputContract?: string;
  }[];
  readonly ignoredFields?: readonly {
    readonly sourcePath: string;
    readonly field: string;
    readonly message: string;
  }[];
}

/** Registry-level plugin view used by lists, settings, and session prep. */
export interface PluginSummary extends PluginLoadDiagnostics {
  readonly trust?: import("../schemas/trusted-sources.js").PluginSourceTrust;
  readonly id: string;
  readonly displayName: I18nText;
  readonly description: I18nText;
  readonly kind: "core" | "plugin";
  readonly source: PluginSource;
  /** Process-wide entry publication; never implies session authorization. */
  readonly hostState: "discovered" | "installed" | "loaded" | "error";
  readonly error?: string;
  readonly registrationError?: {
    readonly code: "plugin_registration_invalid";
    readonly registration: string;
  };
  readonly runtimeCount: number;
  readonly version?: string;
  /** Credits from the package manifest; display data only. */
  readonly author?: PackageAuthor;
  readonly license?: string;
  readonly homepage?: string;
  readonly provides: NonNullable<
    import("./plugin-manifest.js").PluginManifest["provides"]
  >;
  readonly requires: readonly string[];
  readonly optional: readonly string[];
  readonly conflicts: readonly string[];
  readonly extensions: readonly import("../extension-points/index.js").ExtensionDeclaration[];
  /** Topics the package declares in `contributes.events`. */
  readonly eventTopics: readonly string[];
  readonly tags: readonly string[];
  readonly runtimes: readonly PluginRuntimeSummary[];
  readonly tools: readonly PluginToolSummary[];
  readonly userSettings: readonly PluginUserSettingSpec[];
  readonly languages: PluginLanguages;
}

/** The languages a plugin package has text in. English is always one. */
export interface PluginLanguages {
  /** Labels, UI text and text written by code: English plus `locales/<locale>.yaml`. */
  readonly text: readonly string[];
  /** Prompt bodies: English, and `zh` when the plugin has a `*.zh.md` variant. */
  readonly instructions: readonly string[];
}

export interface RuntimePluginContract extends PluginRuntimeSummary {
  readonly name: string;
  readonly description?: I18nText;
  readonly after: readonly DependencyRef[];
  readonly needs: readonly DependencyRef[];
  readonly tools: {
    readonly builtin: readonly string[];
    readonly local: readonly { readonly name: string }[];
  };
  readonly input: {
    readonly inject: readonly unknown[];
    readonly tools: readonly unknown[];
  };
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly effects: {
    readonly reads: readonly EffectResource[];
    readonly writes: readonly EffectResource[];
    readonly parallelSafe: boolean;
  };
  readonly output: Readonly<Record<string, unknown>>;
  readonly dataSchemas: readonly string[];
  readonly writablePluginDataNamespaces: readonly string[];
  readonly readablePluginDataNamespaces: readonly string[];
  readonly userSettings: readonly PluginUserSettingSpec[];
}

export interface PluginDataSchemaContract {
  readonly namespace: string;
  readonly schemaVersion?: number;
  readonly acceptsWorldData?: boolean;
  readonly schema: unknown;
  readonly description?: I18nText;
}

/** Full developer-facing contract for one plugin. */
export interface PluginDetail extends Omit<PluginSummary, "runtimes"> {
  readonly dataSchemas: Readonly<Record<string, PluginDataSchemaContract>>;
  readonly worldProjections: Readonly<
    Record<
      string,
      {
        readonly from: string;
        readonly outputs: Readonly<
          Record<string, { readonly namespace: string; readonly key: string }>
        >;
      }
    >
  >;
  readonly declaredPluginDataNamespaces: readonly string[];
  readonly ui: {
    readonly view: readonly {
      readonly runtimeId?: string;
      readonly path: string;
    }[];
    readonly right: readonly {
      readonly runtimeId?: string;
      readonly path: string;
    }[];
    readonly message: readonly {
      readonly runtimeId?: string;
      readonly path: string;
    }[];
  };
  readonly runtimes: readonly RuntimePluginContract[];
}

export interface SessionPlugin extends PluginSummary {
  readonly serverCodeApprovedBy?: "session" | "trusted-source";
  /** Live authorization for this session, independent of host publication. */
  readonly serverCodeApproved: boolean;
  /** Selected by the player but paused until this process receives approval. */
  readonly approvalRequired?: boolean;
  readonly active: boolean;
  readonly sessionState:
    "active" | "inactive" | "approval-required" | "rejected";
  readonly autoAdded?: boolean;
  readonly rejection?: import("../plugin-selection.js").PluginResolutionRejection;
  readonly locked: boolean;
}

export interface SessionPluginsResponse {
  readonly items: readonly SessionPlugin[];
  readonly commands: readonly SessionSlashCommand[];
  /**
   * Plugins of the session's confirmed set that cannot run now (not
   * installed, failed to load, or a requirement or conflict of the installed
   * version). The game goes on without them.
   */
  readonly unavailable: readonly import("../plugin-selection.js").PluginResolutionRejection[];
}

export interface PluginMutationResponse {
  readonly ok: true;
  readonly activePluginIds: readonly string[];
  /**
   * Enable only: present when plugins joined a session that has a world. The
   * world's data for the joined receivers was imported once.
   */
  readonly worldData?: import("./world-data.js").WorldDataReceiverImport;
}

export interface PluginLoadError {
  readonly pluginId: string;
  readonly errors: readonly string[];
}

/**
 * A named plugin selection a player can pick before play: a built-in pack
 * (`packs/builtin.yaml`), or the one a world presents with its own `pitch`.
 */
export interface PluginPack {
  readonly id: string;
  readonly label: I18nText;
  readonly description?: I18nText;
  readonly requested: readonly string[];
  readonly recommended: readonly string[];
  /** Plugins the pack turns off, core ones included; the player can turn them back on. */
  readonly excluded?: readonly string[];
  readonly tags: readonly string[];
  readonly reason?: I18nText;
  /** `world`: a built-in pack shown with the world's `pitch`. */
  readonly source: "builtin" | "world";
  /**
   * The view a world made for this pack opens new sessions in. The world
   * generator writes it into the world's `defaultViewMode`.
   */
  readonly defaultViewMode?: DefaultViewMode;
}

/** A world's `pluginPolicy`, as the session preparation screen uses it. */
export interface ResolvedWorldPluginPolicy {
  /** The built-in pack a new session starts from. */
  readonly preset?: string;
  /** Plugins the world adds to whichever pack the player picks. */
  readonly plus: readonly string[];
  /** Contract IDs the world needs a provider for. */
  readonly requires: readonly string[];
}

/** A plugin a world requests that is not installed on this host. */
export interface MissingWorldPlugin {
  readonly pluginId: string;
  /** The pack that requests it; absent when the world's `plus` lists it. */
  readonly packId?: string;
}

/**
 * Server-resolved plugin selection plan for one world and live registry.
 *
 * `policy.plus`, each pack's `requested` and `defaultPluginIds` hold
 * installed plugins only, so a client can submit them unchanged. Requests
 * the registry cannot satisfy are reported in `missing` instead.
 */
export interface WorldPluginPlan {
  readonly worldId: string;
  readonly packs: readonly PluginPack[];
  readonly policy: ResolvedWorldPluginPolicy;
  readonly selectedPackId?: string;
  readonly defaultPluginIds: readonly string[];
  readonly missing: readonly MissingWorldPlugin[];
}
