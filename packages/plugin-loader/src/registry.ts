/**
 * In-memory plugin registry — manages plugin lifecycle and lookup.
 */

import {
  getRuntimeSpec,
  pluginDataSchemaMapSchema,
  stageRank,
  type PluginDataSchemaDecl,
  type RuntimeManifest,
  type WorldProjectionDecl,
  worldProjectionMapSchema,
} from "@covel/shared";
import type { EventBus } from "@covel/events";
import type { PluginRegistryEntry, RegistryChangeEvent } from "./types.js";

/**
 * Complete declaration-time runtime definitions for a registry entry.
 * `loadedRuntimes` is deliberately excluded: it is only a partial executable
 * artifact cache and must not influence discovery or session activation.
 */
function declaredRuntimeManifests(
  entry: PluginRegistryEntry,
): readonly RuntimeManifest[] {
  if (entry.manifests && entry.manifests.length > 0) {
    return entry.manifests.map((parsed) => parsed.manifest);
  }
  return entry.manifest ? [entry.manifest.manifest] : [];
}

function isSameDataSchema(
  a: PluginDataSchemaDecl,
  b: PluginDataSchemaDecl,
): boolean {
  return (
    a.namespace === b.namespace &&
    a.schemaVersion === b.schemaVersion &&
    a.acceptsWorldData === b.acceptsWorldData &&
    a.schema === b.schema &&
    a.description === b.description
  );
}

function mergeDataSchemas(
  entry: PluginRegistryEntry,
): Readonly<Record<string, PluginDataSchemaDecl>> | undefined {
  if (entry.dataSchemas) {
    return pluginDataSchemaMapSchema.parse(entry.dataSchemas);
  }

  const merged: Record<string, PluginDataSchemaDecl> = {};

  for (const manifest of declaredRuntimeManifests(entry)) {
    const schemas = manifest.dataSchemas;
    if (!schemas) continue;
    for (const [namespace, schema] of Object.entries(schemas)) {
      const normalized = { ...schema, namespace };
      const existing = merged[namespace];
      if (existing && !isSameDataSchema(existing, normalized)) {
        throw new Error(
          `Conflicting dataSchemas declaration for namespace "${namespace}" in plugin "${entry.id}"`,
        );
      }
      merged[namespace] = normalized;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isSameWorldProjection(
  a: WorldProjectionDecl,
  b: WorldProjectionDecl,
): boolean {
  if (a.from !== b.from || a.handler !== b.handler) return false;
  const aOutputIds = Object.keys(a.outputs).sort();
  const bOutputIds = Object.keys(b.outputs).sort();
  if (
    aOutputIds.length !== bOutputIds.length ||
    aOutputIds.some((id, index) => id !== bOutputIds[index])
  ) {
    return false;
  }
  return aOutputIds.every((id) => {
    const aOutput = a.outputs[id];
    const bOutput = b.outputs[id];
    return (
      aOutput !== undefined &&
      bOutput !== undefined &&
      aOutput.namespace === bOutput.namespace &&
      aOutput.key === bOutput.key
    );
  });
}

function mergeWorldProjections(
  entry: PluginRegistryEntry,
): Readonly<Record<string, WorldProjectionDecl>> | undefined {
  if (entry.worldProjections) {
    return worldProjectionMapSchema.parse(entry.worldProjections);
  }

  const merged: Record<string, WorldProjectionDecl> = {};

  for (const manifest of declaredRuntimeManifests(entry)) {
    const projections = manifest.worldProjections;
    if (!projections) continue;
    for (const [projectionId, projection] of Object.entries(projections)) {
      const existing = merged[projectionId];
      if (existing && !isSameWorldProjection(existing, projection)) {
        throw new Error(
          `Conflicting worldProjections declaration for projection "${projectionId}" in plugin "${entry.id}"`,
        );
      }
      merged[projectionId] = projection;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function validateWorldProjectionTargets(
  pluginId: string,
  dataSchemas: Readonly<Record<string, PluginDataSchemaDecl>> | undefined,
  projections: Readonly<Record<string, WorldProjectionDecl>> | undefined,
): void {
  for (const [projectionId, projection] of Object.entries(projections ?? {})) {
    for (const [outputId, output] of Object.entries(projection.outputs)) {
      const schema = dataSchemas?.[output.namespace];
      if (!schema) {
        throw new Error(
          `worldProjections declaration "${projectionId}" output "${outputId}" in plugin "${pluginId}" targets undeclared dataSchemas namespace "${output.namespace}"`,
        );
      }
      if (!schema.acceptsWorldData) {
        throw new Error(
          `worldProjections declaration "${projectionId}" output "${outputId}" in plugin "${pluginId}" targets namespace "${output.namespace}" that does not accept world data`,
        );
      }
    }
  }
}

function deepFreezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

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

  /** Get active runtimes sorted by (stage, name). */
  getActiveRuntimes(sessionId: string): readonly RuntimeManifest[];

  /** Activate a plugin for a session. Returns false if pluginId is not registered. */
  activate(pluginId: string, sessionId: string): boolean;

  /** Deactivate a plugin for a session. Returns false if pluginId is not registered. */
  deactivate(pluginId: string, sessionId: string): boolean;

  /** Reconcile a session's in-memory activations with a complete persisted snapshot. */
  syncSessionActivations(sessionId: string, pluginIds: readonly string[]): void;

  /** Drop every in-memory activation owned by a deleted session. */
  clearSession(sessionId: string): void;

  /**
   * Find the plugin package ID of an active plugin that declares a given capability.
   * Searches all runtimes (including multi-runtime sub-entries) of active plugins.
   * Returns the first match's plugin ID, or undefined if none found.
   */
  findPluginByCapability(
    sessionId: string,
    capability: string,
  ): string | undefined;

  /** Subscribe to registry changes. Returns unsubscribe function. */
  onChange(handler: (event: RegistryChangeEvent) => void): () => void;
}

/**
 * Create an in-memory plugin registry.
 */
export function createPluginRegistry(
  options?: PluginRegistryOptions,
): PluginRegistry {
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
  function emitToEventBus(
    subType: string,
    sessionId: string,
    payload: Record<string, unknown>,
  ): void {
    if (!eventBus) return;
    eventBus.emit({
      id: crypto.randomUUID(),
      type: "event",
      topic: "plugin",
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { ...payload, _subTopic: "plugin", _subType: subType },
    });
  }

  return {
    register(entry: PluginRegistryEntry): void {
      const dataSchemas = mergeDataSchemas(entry);
      const worldProjections = mergeWorldProjections(entry);
      validateWorldProjectionTargets(entry.id, dataSchemas, worldProjections);
      entries.set(entry.id, {
        ...entry,
        ...(dataSchemas ? { dataSchemas: deepFreezeJson(dataSchemas) } : {}),
        ...(worldProjections
          ? { worldProjections: deepFreezeJson(worldProjections) }
          : {}),
      });
      emit({ type: "plugin-registered", pluginId: entry.id });
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
      if (sessionSet.has(pluginId)) return true;
      sessionSet.add(pluginId);
      emit({ type: "plugin-activated", pluginId, sessionId });
      emitToEventBus("plugin.activated", sessionId, { pluginId, sessionId });
      return true;
    },

    deactivate(pluginId: string, sessionId: string): boolean {
      if (!entries.has(pluginId)) {
        return false;
      }
      const sessionSet = sessionActivations.get(sessionId);
      if (sessionSet === undefined || !sessionSet.delete(pluginId)) return true;
      if (sessionSet.size === 0) sessionActivations.delete(sessionId);
      emit({ type: "plugin-deactivated", pluginId, sessionId });
      emitToEventBus("plugin.deactivated", sessionId, { pluginId, sessionId });
      return true;
    },

    syncSessionActivations(
      sessionId: string,
      pluginIds: readonly string[],
    ): void {
      const desired = new Set(
        pluginIds.filter((pluginId) => entries.has(pluginId)),
      );
      if (desired.size === 0) {
        sessionActivations.delete(sessionId);
      } else {
        sessionActivations.set(sessionId, desired);
      }
    },

    clearSession(sessionId: string): void {
      sessionActivations.delete(sessionId);
    },

    onChange(handler: (event: RegistryChangeEvent) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    findPluginByCapability(
      sessionId: string,
      capability: string,
    ): string | undefined {
      const sessionSet = sessionActivations.get(sessionId);
      if (sessionSet === undefined || sessionSet.size === 0) return undefined;

      for (const pluginId of sessionSet) {
        const entry = entries.get(pluginId);
        if (!entry) continue;
        for (const manifest of declaredRuntimeManifests(entry)) {
          if (manifest.capabilities?.includes(capability)) return pluginId;
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
        manifests.push(...declaredRuntimeManifests(entry));
      }

      // Sort by (stage, name). Stage-less runtimes (event / manual / UI-only)
      // rank last — they are never band-scheduled but can appear in listings.
      // event-directory's first-wins topic resolution consumes this order.
      return manifests.sort((a, b) => {
        const ra = stageRank(getRuntimeSpec(a).stage);
        const rb = stageRank(getRuntimeSpec(b).stage);
        return ra - rb || a.name.localeCompare(b.name);
      });
    },
  };
}
