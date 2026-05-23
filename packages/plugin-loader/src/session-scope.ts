/**
 * Session-scoped plugin activation and configuration.
 *
 * Legacy/test-only helper. Production session activation is now stored on
 * SessionRecord.activePlugins and resolved through server session routes.
 * Keep this small utility only for compatibility with older tests/imports.
 */

export interface SessionPluginScope {
  readonly sessionId: string;

  /** Currently active plugin IDs. */
  readonly activePluginIds: ReadonlySet<string>;

  /** Enable a plugin for this session. Returns false if already enabled or is core-plugin. */
  enable(pluginId: string): boolean;

  /** Disable a plugin. Returns false if it's a core-plugin (cannot disable). */
  disable(pluginId: string): boolean;

  /** Check if a plugin is active. */
  isActive(pluginId: string): boolean;

  /** Get effective config for a plugin (defaults merged with overrides). */
  getEffectiveConfig(pluginId: string): Readonly<Record<string, unknown>>;

  /** Set config override for a plugin. */
  setConfigOverride(
    pluginId: string,
    config: Readonly<Record<string, unknown>>,
  ): void;
}

/**
 * Create a session-scoped plugin manager.
 *
 * @param sessionId - Session identifier
 * @param initialPlugins - Initially active plugin IDs
 * @param corePlugins - Plugin IDs that cannot be disabled
 */
export function createSessionScope(
  sessionId: string,
  initialPlugins: readonly string[],
  corePlugins: ReadonlySet<string>,
): SessionPluginScope {
  const activeSet = new Set<string>(initialPlugins);
  const configOverrides = new Map<string, Readonly<Record<string, unknown>>>();

  return {
    get sessionId() {
      return sessionId;
    },

    get activePluginIds(): ReadonlySet<string> {
      return new Set(activeSet);
    },

    enable(pluginId: string): boolean {
      if (activeSet.has(pluginId)) {
        return false;
      }
      activeSet.add(pluginId);
      return true;
    },

    disable(pluginId: string): boolean {
      if (corePlugins.has(pluginId)) {
        return false;
      }
      if (!activeSet.has(pluginId)) {
        return false;
      }
      activeSet.delete(pluginId);
      return true;
    },

    isActive(pluginId: string): boolean {
      return activeSet.has(pluginId);
    },

    getEffectiveConfig(pluginId: string): Readonly<Record<string, unknown>> {
      return configOverrides.get(pluginId) ?? {};
    },

    setConfigOverride(
      pluginId: string,
      config: Readonly<Record<string, unknown>>,
    ): void {
      configOverrides.set(pluginId, config);
    },
  };
}
