import { compareText } from "@covel/shared";
import { AsyncLocalStorage } from "node:async_hooks";
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
import type {
  PluginRegistryEntry,
  RegistryChangeEvent,
  PackageManifest,
} from "./types.js";
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
 * Registration replaces the entry object, so old snapshots retain their
 * manifests while the new registration gets a fresh cache entry.
 */
const runtimeManifestsCache = new WeakMap<
  PluginRegistryEntry,
  readonly RuntimeManifest[]
>();

function declaredRuntimeManifests(
  entry: PluginRegistryEntry,
): readonly RuntimeManifest[] {
  const cached = runtimeManifestsCache.get(entry);
  if (cached) return cached;
  const manifests = pluginRuntimeManifests(entry).map((parsed) =>
    resolvePluginRuntimeManifest(entry, parsed.manifest),
  );
  runtimeManifestsCache.set(entry, manifests);
  return manifests;
}

function mergeDataSchemas(
  entry: PluginRegistryEntry,
): Readonly<Record<string, PluginDataSchemaDecl>> | undefined {
  const schemas =
    entry.dataSchemas ??
    resolvePluginDeclarations(pluginDeclarations(entry)).dataSchemas;
  return Object.keys(schemas).length
    ? pluginDataSchemaMapSchema.parse(schemas)
    : undefined;
}
function mergeWorldProjections(
  entry: PluginRegistryEntry,
): Readonly<Record<string, WorldProjectionDecl>> | undefined {
  const projections =
    entry.worldProjections ??
    resolvePluginDeclarations(pluginDeclarations(entry)).worldProjections;
  return Object.keys(projections).length
    ? worldProjectionMapSchema.parse(projections)
    : undefined;
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
  /**
   * The session plugin set: given a session's confirmed plugin IDs and the
   * entries a read sees, the IDs that run. Every active-set read goes through
   * it, so a reload or upgrade is applied at once and nothing is written back.
   * Without it a session runs exactly its confirmed IDs.
   */
  readonly resolveSessionSet?: (
    confirmed: readonly string[],
    entries: ReadonlyMap<string, PluginRegistryEntry>,
  ) => readonly string[];
}

/**
 * Read-only contract note: a session's authoritative activation set is its
 * persisted `session.activePlugins` record. The registry's `sessionActivations`
 * map is a process-local mirror of that record, and every mutation of the
 * mirror must be ordered *after* the durable write — see
 * `applyPersistedActivations` (the single sanctioned mutation path) and
 * `syncSessionActivations` (read-repair from a snapshot taken under the
 * session lock). The record is the set the player confirmed; reads of the
 * active set pass it through `resolveSessionSet` against the entries they see.
 */
export interface PluginRegistry {
  withSnapshot<T>(fn: () => T): T;
  /** Register a plugin. */
  register(entry: PluginRegistryEntry): void;

  /** Get all registered plugins. */
  getAll(): ReadonlyMap<string, PluginRegistryEntry>;

  /** Get a plugin by ID. */
  get(id: string): PluginRegistryEntry | undefined;

  /** Get active runtimes sorted by (stage, name). */
  getActiveRuntimes(sessionId: string): readonly RuntimeManifest[];
  /** Active package declarations, sorted by name, including zero-runtime packages. */
  getActivePluginDeclarations(sessionId: string): readonly PackageManifest[];

  /** The session's plugin set: its confirmed IDs through `resolveSessionSet`. */
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
    sessionIncarnation: string,
  ): Promise<void>;

  /**
   * Read-repair only: reconcile a session's in-memory activations with a
   * complete persisted snapshot that was just read under the session lock
   * (restart recovery / cross-instance staleness). Emits no lifecycle events.
   * Must not be used to apply a mutation — every change to the authoritative
   * set goes through `applyPersistedActivations`, which persists first.
   */
  syncSessionActivations(sessionId: string, pluginIds: readonly string[]): void;

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
  const snapshots = new AsyncLocalStorage<
    ReadonlyMap<string, PluginRegistryEntry>
  >();
  const readableEntries = () => snapshots.getStore() ?? entries;
  const activationSnapshots = new AsyncLocalStorage<
    ReadonlyMap<string, ReadonlySet<string>>
  >();
  const readableActivations = () =>
    activationSnapshots.getStore() ?? sessionActivations;
  // Process-local mirror of each session's persisted `activePlugins`.
  // Only `applyPersistedActivations` (persist-first mutation) and
  // `syncSessionActivations` (locked read-repair) may write to it.
  const sessionActivations = new Map<string, Set<string>>();
  const listeners = new Set<(event: RegistryChangeEvent) => void>();
  const eventBus = options?.eventBus;
  // Bumped on every registration, so a cached set never outlives the entries
  // it was resolved against.
  let generation = 0;
  const resolvedSets = new WeakMap<
    ReadonlySet<string>,
    {
      readonly entries: ReadonlyMap<string, PluginRegistryEntry>;
      readonly generation: number;
      readonly ids: readonly string[];
      runtimes?: readonly RuntimeManifest[];
    }
  >();
  const activeSet = (sessionId: string) => {
    const confirmed = readableActivations().get(sessionId);
    if (!confirmed || confirmed.size === 0) return undefined;
    const resolve = options?.resolveSessionSet;
    const current = readableEntries();
    const cached = resolvedSets.get(confirmed);
    if (cached?.entries === current && cached.generation === generation)
      return cached;
    const ids = resolve ? resolve([...confirmed], current) : [...confirmed];
    const resolved: NonNullable<ReturnType<typeof resolvedSets.get>> = {
      entries: current,
      generation,
      ids,
    };
    resolvedSets.set(confirmed, resolved);
    return resolved;
  };
  const activeIds = (sessionId: string): readonly string[] =>
    activeSet(sessionId)?.ids ?? [];

  const reconcileActivations = (sessionId: string, desired: Set<string>) => {
    const previous = sessionActivations.get(sessionId);
    if (desired.size === 0) sessionActivations.delete(sessionId);
    else if (
      previous?.size !== desired.size ||
      [...desired].some((id) => !previous.has(id))
    )
      sessionActivations.set(sessionId, desired);
  };

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
    sessionIncarnation: string,
  ): void {
    if (!eventBus) return;
    eventBus.emit({
      id: crypto.randomUUID(),
      type: "event",
      topic: "plugin",
      sessionId,
      sessionIncarnation,
      timestamp: new Date().toISOString(),
      payload: { ...payload, _subTopic: "plugin", _subType: subType },
    });
  }

  return {
    withSnapshot(fn) {
      return snapshots.getStore()
        ? fn()
        : snapshots.run(new Map(entries), () =>
            activationSnapshots.run(new Map(sessionActivations), fn),
          );
    },
    register(entry: PluginRegistryEntry): void {
      const dataSchemas = mergeDataSchemas(entry);
      const worldProjections = mergeWorldProjections(entry);
      validateWorldProjectionTargets(entry.id, dataSchemas, worldProjections);
      for (const [id, other] of entries) {
        if (id === entry.id) continue;
        for (const [contract, schema] of Object.entries(
          entry.packageManifest?.contractSchemas ?? {},
        )) {
          const existing = other.packageManifest?.contractSchemas?.[contract];
          if (existing && canonicalSchema(existing) !== canonicalSchema(schema))
            throw new Error(
              `Conflicting schema for contract ${contract} between ${entry.id} and ${id}; publish one shared schema or a new contract version`,
            );
        }
      }
      generation += 1;
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
      return new Map(readableEntries());
    },

    get(id: string): PluginRegistryEntry | undefined {
      return readableEntries().get(id);
    },

    getActivePlugins(sessionId: string): readonly string[] {
      return [...activeIds(sessionId)];
    },

    async applyPersistedActivations(
      sessionId: string,
      pluginIds: readonly string[],
      persist: () => Promise<void>,
      sessionIncarnation: string,
    ): Promise<void> {
      // Durable state first: a failed persist must never be reflected here.
      await persist();
      const previous = sessionActivations.get(sessionId);
      const desired = new Set(
        pluginIds.filter((pluginId) => entries.has(pluginId)),
      );
      reconcileActivations(sessionId, desired);
      for (const pluginId of desired) {
        if (previous?.has(pluginId)) continue;
        emit({ type: "plugin-activated", pluginId, sessionId });
        emitToEventBus(
          "plugin.activated",
          sessionId,
          { pluginId, sessionId },
          sessionIncarnation,
        );
      }
      for (const pluginId of previous ?? []) {
        if (desired.has(pluginId)) continue;
        emit({ type: "plugin-deactivated", pluginId, sessionId });
        emitToEventBus(
          "plugin.deactivated",
          sessionId,
          {
            pluginId,
            sessionId,
          },
          sessionIncarnation,
        );
      }
    },

    syncSessionActivations(
      sessionId: string,
      pluginIds: readonly string[],
    ): void {
      const desired = new Set(
        pluginIds.filter((pluginId) => entries.has(pluginId)),
      );
      reconcileActivations(sessionId, desired);
    },

    onChange(handler: (event: RegistryChangeEvent) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    getActivePluginDeclarations(sessionId: string): readonly PackageManifest[] {
      return activeIds(sessionId)
        .flatMap((id) => {
          const entry = readableEntries().get(id);
          return entry
            ? pluginDeclarations(entry).map(({ manifest }) => manifest)
            : [];
        })
        .sort((a, b) => compareText(a.name, b.name));
    },

    getActiveRuntimes(sessionId: string): readonly RuntimeManifest[] {
      const resolved = activeSet(sessionId);
      if (!resolved) return [];
      if (resolved.runtimes) return [...resolved.runtimes];

      const manifests: RuntimeManifest[] = [];

      for (const pluginId of resolved.ids) {
        const entry = readableEntries().get(pluginId);
        if (!entry) continue;
        manifests.push(...declaredRuntimeManifests(entry));
      }

      // Sort by (stage, name). Stage-less runtimes (event / manual / UI-only)
      // rank last — they are never band-scheduled but can appear in listings.
      // event-directory's first-wins topic resolution consumes this order.
      resolved.runtimes = resolveRuntimeProviders(manifests).sort((a, b) => {
        const ra = stageRank(getRuntimeSpec(a).stage);
        const rb = stageRank(getRuntimeSpec(b).stage);
        return ra - rb || compareText(a.name, b.name);
      });
      return [...resolved.runtimes];
    },
  };
}

function canonicalSchema(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSchema).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareText(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalSchema(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
