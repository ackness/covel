/** Resolve role preferences while keeping complete plugin targets separate from preset IDs. */
import type { RuntimeManifest } from "@covel/shared";
import type {
  PluginLlmConfig,
  PluginLlmSlot,
} from "@covel/shared/plugin-runtime";

export interface PluginLlmModelTarget extends PluginLlmSlot {
  readonly role: string;
}

export interface ModelResolverConfig {
  readonly pluginLlmConfigs: ReadonlyMap<string, PluginLlmConfig>;
  /** Shared with gateway adapters; these immutable targets survive system TOML reloads. */
  readonly modelTargets: Map<string, PluginLlmModelTarget>;
  /** Request-selected role bindings take precedence over plugin preferences. */
  readonly isRoleSelected?: (role: string) => boolean;
}

export function createModelResolver(
  config: ModelResolverConfig,
): (manifest: RuntimeManifest, apiOverride?: string) => string | undefined {
  const references = new Map<string, Map<string, string>>();
  for (const [runtime, pluginConfig] of config.pluginLlmConfigs) {
    const slots = new Map<string, string>();
    for (const [role, target] of Object.entries(pluginConfig.slots)) {
      const id = "\u0000plugin-model:" + JSON.stringify([runtime, role]);
      config.modelTargets.set(id, Object.freeze({ ...target, role }));
      slots.set(role, id);
    }
    references.set(runtime, slots);
  }

  return (manifest, apiOverride) => {
    // An explicit API/runtime selection names the user's role or preset,
    // and must never be interpreted as a plugin-local model preference.
    if (apiOverride) return apiOverride;
    const role = manifest.model ?? "default";
    if (config.isRoleSelected?.(role)) return role;
    return references.get(manifest.name)?.get(role) ?? manifest.model;
  };
}
