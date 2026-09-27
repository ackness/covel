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
import { resolveRuntimeProviders } from "./runtime-providers.js";
import type { EventBus } from "@covel/events";
import type { PluginRegistryEntry, RegistryChangeEvent } from "./types.js";
import {
  pluginDeclarations,
  pluginRuntimeManifests,
  resolvePluginRuntimeManifest,
  resolvePluginDeclarations,
} from "./declarations.js";

/**
 * Complete declaration-time runtime definitions for a registry entry.
 * `loadedRuntimes` is deliberately excluded: it is only a partial executable
 * artifact cache and must not influence discovery or session activation.
 */
function declaredRuntimeManifests(
  entry: PluginRegistryEntry,
): readonly RuntimeManifest[] {
  return pluginRuntimeManifests(entry).map((parsed) =>
    resolvePluginRuntimeManifest(entry, parsed.manifest),
  );
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

  for (const { manifest } of pluginDeclarations(entry)) {
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

  for (const { manifest } of pluginDeclarations(entry)) {
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

/**
 * Read-only contract note: a session's authoritative activation set is its
 * persisted `session.activePlugins` record. The registry's `sessionActivations`
 * map is a process-local mirror of that record, and every mutation of the
 * mirror must be ordered *after* the durable write — see
 * `applyPersistedActivations` (the single sanctioned mutation path) and
 * `syncSessionActivations` (read-repair from a snapshot taken under the
 * session lock).
 */
export interface PluginRegistry {
  /** Register a plugin. */
  register(entry: PluginRegistryEntry): void;

  /** Get all registered plugins. */
  getAll(): ReadonlyMap<string, PluginRegistryEntry>;

  /** Get a plugin by ID. */
  get(id: string): PluginRegistryEntry | undefined;

  /** Get active runtimes sorted by (stage, name). */
  getActiveRuntimes(sessionId: string): readonly RuntimeManifest[];
  /** Active package and runtime-local source declarations, including zero-runtime packages. */
  getActivePluginDeclarations(sessionId: string): readonly RuntimeManifest[];

  /** Read-only view of a session's in-memory activation set. */
  getActivePlugins(sessionId: string): readonly string[];

  /**
   * Single sanctioned mutation path for a session's activation set.
   *
   * `persist` must first establish the authoritative durable state — write
   * the session's `activePlugins`, delete the session row, or verify that an
   * earlier durable write landed (e.g. a create transaction). Only after it
   * resolves is the process-local mirror reconciled to `pluginIds` and the
   * per-plugin `plugin-activated` / `plugin-deactivated` lifecycle events are
   * emitted for the actual delta. A rejected `persist` propagates and leaves
   * memory untouched, so the mirror can never run ahead of the store and
   * callers cannot "forget to write the database first".
   *
   * Unknown plugin IDs are filtered out (same rule as `syncSessionActivations`).
   * Passing an empty set drops the session's activations entirely — this also
   * covers deleted sessions.
   */
  applyPersistedActivations(
    sessionId: string,
    pluginIds: readonly string[],
    persist: () => Promise<void>,
  ): Promise<void>;

  /**
   * Read-repair only: reconcile a session's in-memory activations with a
   * complete persisted snapshot that was just read under the session lock
   * (restart recovery / cross-instance staleness). Emits no lifecycle events.
   * Must not be used to apply a mutation — every change to the authoritative
   * set goes through `applyPersistedActivations`, which persists first.
   */
  syncSessionActivations(sessionId: string, pluginIds: readonly string[]): void;

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
  // Process-local mirror of each session's persisted `activePlugins`.
  // Only `applyPersistedActivations` (persist-first mutation) and
  // `syncSessionActivations` (locked read-repair) may write to it.
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
      resolvePluginDeclarations(pluginDeclarations(entry));
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

    getActivePlugins(sessionId: string): readonly string[] {
      return [...(sessionActivations.get(sessionId) ?? [])];
    },

    async applyPersistedActivations(
      sessionId: string,
      pluginIds: readonly string[],
      persist: () => Promise<void>,
    ): Promise<void> {
      // Durable state first: a failed persist must never be reflected here.
      await persist();
      const previous = sessionActivations.get(sessionId);
      const desired = new Set(
        pluginIds.filter((pluginId) => entries.has(pluginId)),
      );
      if (desired.size === 0) {
        sessionActivations.delete(sessionId);
      } else {
        sessionActivations.set(sessionId, desired);
      }
      for (const pluginId of desired) {
        if (previous?.has(pluginId)) continue;
        emit({ type: "plugin-activated", pluginId, sessionId });
        emitToEventBus("plugin.activated", sessionId, { pluginId, sessionId });
      }
      for (const pluginId of previous ?? []) {
        if (desired.has(pluginId)) continue;
        emit({ type: "plugin-deactivated", pluginId, sessionId });
        emitToEventBus("plugin.deactivated", sessionId, {
          pluginId,
          sessionId,
        });
      }
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
        const root = entry?.packageManifest;
        if (
          entry &&
          root &&
          !pluginRuntimeManifests(entry).some(
            (runtime) => runtime.manifest.name === root.manifest.name,
          ) &&
          root.manifest.capabilities?.includes(capability)
        )
          return pluginId;
      }

      const active = [...sessionSet].flatMap((pluginId) => {
        const entry = entries.get(pluginId);
        return entry
          ? declaredRuntimeManifests(entry).map((manifest) => ({
              ...manifest,
              pluginId,
            }))
          : [];
      });
      return resolveRuntimeProviders(active).find((manifest) =>
        manifest.capabilities?.includes(capability),
      )?.pluginId;
    },

    getActivePluginDeclarations(sessionId: string): readonly RuntimeManifest[] {
      return [...(sessionActivations.get(sessionId) ?? [])]
        .flatMap((id) => {
          const entry = entries.get(id);
          return entry
            ? pluginDeclarations(entry).map(({ manifest }) => manifest)
            : [];
        })
        .sort(
          (a, b) =>
            stageRank(getRuntimeSpec(a).stage) -
              stageRank(getRuntimeSpec(b).stage) ||
            a.name.localeCompare(b.name),
        );
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
      return resolveRuntimeProviders(manifests).sort((a, b) => {
        const ra = stageRank(getRuntimeSpec(a).stage);
        const rb = stageRank(getRuntimeSpec(b).stage);
        return ra - rb || a.name.localeCompare(b.name);
      });
    },
  };
}
