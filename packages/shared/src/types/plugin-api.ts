/** Canonical HTTP DTOs for plugin discovery and session plugin state. */

import type { EffectiveTurnCompletion } from "../scheduling/normalize.js";
import type {
  DependencyRef,
  EffectResource,
  Stage,
} from "./runtime-scheduling.js";
import type {
  PluginRelations,
  PluginType,
  PluginUserSettingSpec,
  SessionSlashCommand,
} from "./plugin.js";
import type { I18nText } from "./world.js";

export type PluginSource = "builtin" | "community";

export type PluginStatus =
  "discovered" | "registered" | "active" | "disabled" | "error";

export interface PluginRuntimeTrigger {
  readonly type: "auto" | "manual" | "scheduled" | "event";
  readonly interval?: number;
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
  readonly model?: string;
  readonly outputKind: "story" | "plugin" | "system";
  readonly capabilities: readonly string[];
  readonly tags: readonly string[];
  readonly relations?: PluginRelations;
}

export interface PluginToolSummary {
  readonly id: string;
  readonly kind: "builtin" | "local";
  readonly runtimeId?: string;
}

/** Registry-level plugin view used by lists, settings, and session prep. */
export interface PluginSummary {
  readonly id: string;
  readonly displayName: I18nText;
  readonly description: I18nText;
  readonly pluginType: PluginType;
  readonly source: PluginSource;
  readonly status: PluginStatus;
  readonly error?: string;
  readonly runtimeCount: number;
  readonly version?: string;
  readonly capabilities: readonly string[];
  readonly tags: readonly string[];
  readonly relations?: PluginRelations;
  readonly runtimes: readonly PluginRuntimeSummary[];
  readonly tools: readonly PluginToolSummary[];
  readonly userSettings: readonly PluginUserSettingSpec[];
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
  readonly ui: {
    readonly right: readonly string[];
    readonly message: readonly string[];
    readonly left: readonly string[];
  };
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
    readonly right: readonly {
      readonly runtimeId: string;
      readonly path: string;
    }[];
    readonly message: readonly {
      readonly runtimeId: string;
      readonly path: string;
    }[];
    readonly left: readonly {
      readonly runtimeId: string;
      readonly path: string;
    }[];
  };
  readonly runtimes: readonly RuntimePluginContract[];
}

export interface SessionPlugin extends PluginSummary {
  readonly active: boolean;
  readonly locked: boolean;
}

export interface SessionPluginsResponse {
  readonly items: readonly SessionPlugin[];
  readonly commands: readonly SessionSlashCommand[];
}

export interface PluginMutationResponse {
  readonly ok: true;
  readonly activePluginIds: readonly string[];
}

export interface PluginLoadError {
  readonly pluginId: string;
  readonly errors: readonly string[];
}

export interface PluginPack {
  readonly id: string;
  readonly label: I18nText;
  readonly description?: I18nText;
  readonly pluginIds: readonly string[];
  readonly optionalPluginIds: readonly string[];
  readonly excludedPluginIds: readonly string[];
  readonly tags: readonly string[];
  readonly reason?: I18nText;
  readonly source: "builtin" | "world";
}

export interface ResolvedWorldPluginPolicy {
  readonly presetId?: string;
  readonly preferredTags: readonly string[];
  readonly avoidedTags: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly requiredPluginIds: readonly string[];
  readonly recommendedPluginIds: readonly string[];
  readonly excludedPluginIds: readonly string[];
}

/** Server-resolved plugin selection plan for one world and live registry. */
export interface WorldPluginPlan {
  readonly worldId: string;
  readonly packs: readonly PluginPack[];
  readonly policy: ResolvedWorldPluginPolicy;
  readonly selectedPackId?: string;
  readonly defaultPluginIds: readonly string[];
}
