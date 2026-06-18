import { FrameworkCapability } from "@covel/shared";
import type { PluginRegistry } from "@covel/plugin-loader";

/**
 * Plugin ids the turn pipeline consumes via framework capabilities.
 *
 * The framework never hardcodes plugin ids — it discovers providers by
 * declared `capabilities`. This object is the single place that maps the
 * turn-pipeline's framework capabilities to the active plugin ids, so routes
 * don't repeat the discovery and adding a newly framework-consumed capability
 * is a one-line change here instead of an edit across every route.
 */
export interface TurnCapabilityPluginIds {
  /** `world-data-provider` — supplies world dimensions / lorebook seeds. */
  readonly worldDataPluginId: string | undefined;
  /** `persona-provider` — supplies the active player persona. */
  readonly personaPluginId: string | undefined;
  /** `prompt-history-rewriter` — projects accepted branch-reply candidates. */
  readonly promptHistoryRewriterPluginId: string | undefined;
}

/**
 * Resolve the framework-capability plugin ids the turn pipeline needs for a
 * session. An absent capability simply leaves the corresponding feature off.
 */
export function resolveTurnCapabilityPluginIds(
  pluginRegistry: PluginRegistry,
  sessionId: string,
): TurnCapabilityPluginIds {
  return {
    worldDataPluginId: pluginRegistry.findPluginByCapability(
      sessionId,
      FrameworkCapability.WorldDataProvider,
    ),
    personaPluginId: pluginRegistry.findPluginByCapability(
      sessionId,
      FrameworkCapability.PersonaProvider,
    ),
    promptHistoryRewriterPluginId: pluginRegistry.findPluginByCapability(
      sessionId,
      FrameworkCapability.PromptHistoryRewriter,
    ),
  };
}
