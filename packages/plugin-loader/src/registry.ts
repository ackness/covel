/**
 * In-memory plugin registry — manages plugin lifecycle and lookup.
 */

import type { RuntimeManifest } from '@covel/shared';
import type {
  PluginRegistryEntry,
  PluginSummary,
  RegistryChangeEvent,
} from './types.js';

export interface PluginRegistry {
  /** Register a plugin. */
  register(entry: PluginRegistryEntry): void;

  /** Get all registered plugins. */
  getAll(): ReadonlyMap<string, PluginRegistryEntry>;

  /** Get a plugin by ID. */
  get(id: string): PluginRegistryEntry | undefined;

  /** Get active runtimes sorted by priority (ascending). */
  getActiveRuntimes(sessionId: string): readonly RuntimeManifest[];

  /** Activate a plugin for a session. */
  activate(pluginId: string, sessionId: string): void;

  /** Deactivate a plugin for a session. */
  deactivate(pluginId: string, sessionId: string): void;

  /** Subscribe to registry changes. Returns unsubscribe function. */
  onChange(handler: (event: RegistryChangeEvent) => void): () => void;
}

/**
 * Create an in-memory plugin registry.
 */
export function createPluginRegistry(): PluginRegistry {
  const entries = new Map<string, PluginRegistryEntry>();
  const sessionActivations = new Map<string, Set<string>>();
  const listeners = new Set<(event: RegistryChangeEvent) => void>();

  function emit(event: RegistryChangeEvent): void {
    for (const handler of listeners) {
      handler(event);
    }
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

    activate(pluginId: string, sessionId: string): void {
      let sessionSet = sessionActivations.get(sessionId);
      if (sessionSet === undefined) {
        sessionSet = new Set();
        sessionActivations.set(sessionId, sessionSet);
      }
      sessionSet.add(pluginId);
      emit({ type: 'plugin-activated', pluginId, sessionId });
    },

    deactivate(pluginId: string, sessionId: string): void {
      const sessionSet = sessionActivations.get(sessionId);
      if (sessionSet !== undefined) {
        sessionSet.delete(pluginId);
      }
      emit({ type: 'plugin-deactivated', pluginId, sessionId });
    },

    onChange(handler: (event: RegistryChangeEvent) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    getActiveRuntimes(sessionId: string): readonly RuntimeManifest[] {
      const sessionSet = sessionActivations.get(sessionId);
      if (sessionSet === undefined || sessionSet.size === 0) {
        return [];
      }

      const manifests: RuntimeManifest[] = [];

      for (const pluginId of sessionSet) {
        const entry = entries.get(pluginId);
        if (entry?.manifest !== undefined) {
          manifests.push(entry.manifest.manifest);
        }
      }

      return manifests.sort((a, b) => a.priority - b.priority);
    },
  };
}
