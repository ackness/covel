/**
 * In-memory plugin registry — manages plugin lifecycle and lookup.
 */

import type { RuntimeManifest } from '@covel/shared';
import type { EventBus } from '@covel/events';
import type {
  PluginRegistryEntry,
  PluginSummary,
  RegistryChangeEvent,
} from './types.js';

export interface PluginRegistryOptions {
  /** Optional EventBus for emitting plugin lifecycle subscription events. */
  readonly eventBus?: EventBus;
}

export interface PluginRegistry {
  /** Register a plugin. */
  register(entry: PluginRegistryEntry): void;

  /** Get all registered plugins. */
  getAll(): ReadonlyMap<string, PluginRegistryEntry>;

  /** Get a plugin by ID. */
  get(id: string): PluginRegistryEntry | undefined;

  /** Get active runtimes sorted by priority (ascending). */
  getActiveRuntimes(sessionId: string): readonly RuntimeManifest[];

  /** Activate a plugin for a session. Returns false if pluginId is not registered. */
  activate(pluginId: string, sessionId: string): boolean;

  /** Deactivate a plugin for a session. Returns false if pluginId is not registered. */
  deactivate(pluginId: string, sessionId: string): boolean;

  /**
   * Find the plugin package ID of an active plugin that declares a given capability.
   * Searches all runtimes (including multi-runtime sub-entries) of active plugins.
   * Returns the first match's plugin ID, or undefined if none found.
   */
  findPluginByCapability(sessionId: string, capability: string): string | undefined;

  /** Subscribe to registry changes. Returns unsubscribe function. */
  onChange(handler: (event: RegistryChangeEvent) => void): () => void;
}

/**
 * Create an in-memory plugin registry.
 */
export function createPluginRegistry(options?: PluginRegistryOptions): PluginRegistry {
  const entries = new Map<string, PluginRegistryEntry>();
  const sessionActivations = new Map<string, Set<string>>();
  const listeners = new Set<(event: RegistryChangeEvent) => void>();
  const eventBus = options?.eventBus;

  function emit(event: RegistryChangeEvent): void {
    for (const handler of listeners) {
      handler(event);
    }
  }

  /** Emit a subscription event to the EventBus (if present). */
  function emitToEventBus(subType: string, sessionId: string, payload: Record<string, unknown>): void {
    if (!eventBus) return;
    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'event',
      topic: 'plugin',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { ...payload, _subTopic: 'plugin', _subType: subType },
    });
  }

  return {
    register(entry: PluginRegistryEntry): void {
      entries.set(entry.id, entry);
      emit({ type: 'plugin-registered', pluginId: entry.id });
    },

    getAll(): ReadonlyMap<string, PluginRegistryEntry> {
      return new Map(entries);
    },

    get(id: string): PluginRegistryEntry | undefined {
      return entries.get(id);
    },

    activate(pluginId: string, sessionId: string): boolean {
      if (!entries.has(pluginId)) {
        return false;
      }
      let sessionSet = sessionActivations.get(sessionId);
      if (sessionSet === undefined) {
        sessionSet = new Set();
        sessionActivations.set(sessionId, sessionSet);
      }
      sessionSet.add(pluginId);
      emit({ type: 'plugin-activated', pluginId, sessionId });
      emitToEventBus('plugin.activated', sessionId, { pluginId, sessionId });
      return true;
    },

    deactivate(pluginId: string, sessionId: string): boolean {
      if (!entries.has(pluginId)) {
        return false;
      }
      const sessionSet = sessionActivations.get(sessionId);
      if (sessionSet !== undefined) {
        sessionSet.delete(pluginId);
      }
      emit({ type: 'plugin-deactivated', pluginId, sessionId });
      emitToEventBus('plugin.deactivated', sessionId, { pluginId, sessionId });
      return true;
    },

    onChange(handler: (event: RegistryChangeEvent) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    findPluginByCapability(sessionId: string, capability: string): string | undefined {
      const sessionSet = sessionActivations.get(sessionId);
      if (sessionSet === undefined || sessionSet.size === 0) return undefined;

      for (const pluginId of sessionSet) {
        const entry = entries.get(pluginId);
        if (!entry) continue;
        // Check the primary manifest
        if (entry.manifest?.manifest.capabilities?.includes(capability)) return pluginId;
        // Check all loaded runtimes (multi-runtime plugins store sub-runtimes here)
        for (const [, loaded] of entry.loadedRuntimes) {
          if (loaded.manifest.capabilities?.includes(capability)) return pluginId;
        }
      }
      return undefined;
    },

    getActiveRuntimes(sessionId: string): readonly RuntimeManifest[] {
      const sessionSet = sessionActivations.get(sessionId);
      if (sessionSet === undefined || sessionSet.size === 0) {
        return [];
      }

      const manifests: RuntimeManifest[] = [];

      for (const pluginId of sessionSet) {
        const entry = entries.get(pluginId);
        if (!entry) continue;
        // Include all manifests for multi-runtime plugins
        if (entry.manifests && entry.manifests.length > 0) {
          for (const parsed of entry.manifests) {
            manifests.push(parsed.manifest);
          }
        } else if (entry.manifest !== undefined) {
          manifests.push(entry.manifest.manifest);
        }
      }

      return manifests.sort((a, b) => a.priority - b.priority);
    },
  };
}
