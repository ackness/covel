import { isRecord } from "../../../lib/is-record.js";
import { publicSessionIncarnation } from "../session/session-guard.js";
/**
 * Shared types + helpers for the world route modules (crud / dimensions /
 * data-sync). The world routes were split out of a single 543-line file; this
 * module holds the pieces more than one of them needs.
 */

import { validateDimensions } from "@covel/shared";
import type { DataStore, MediaStore, WorldRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import { errorBody, type ApiErrorResponse } from "../../../api-error.js";
import type { SessionLock } from "../../../lib/session-lock.js";
import { withoutWorldDeletion } from "../../../world-lifecycle.js";

export type WorldEnv = {
  Variables: {
    store: DataStore;
    eventBus: EventBus;
    pluginRegistry: PluginRegistry;
    mediaStore?: MediaStore;
    worldsDirs?: readonly string[];
    covelHome?: string;
    sessionLock: SessionLock;
  };
};

/**
 * Whether the record was made from a package of files: a bundled, installed
 * or generated package that a reload, the startup seed or an update reads
 * again.
 */
export function isPackageWorld(world: WorldRecord): boolean {
  const { source, packageManaged } = world.metadata ?? {};
  return (
    packageManaged === true || source === "file" || source === "generated-file"
  );
}

/**
 * The metadata of a world whose authored content was changed in the app.
 *
 * The record is the world; a package is only what it was installed from. The
 * change is in the store only, so the record of a package world is marked:
 * a package reload, the startup seed or an update keeps a marked record
 * instead of replacing it with the files, until the player restores the
 * package version. Every route that changes a world's content saves its
 * metadata through this.
 */
export function editedWorldMetadata(
  existing: WorldRecord,
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  return {
    ...metadata,
    ...(isPackageWorld(existing) ? { packageModified: true } : {}),
  };
}

export function resolveWorldMetadata(
  body: Record<string, unknown>,
  existingMetadata?: Readonly<Record<string, unknown>>,
): {
  metadata?: Record<string, unknown>;
  changedDimensionKeys?: readonly string[];
  error?: { status: 400 | 422; body: ApiErrorResponse };
} {
  const hasMetadataPatch = Object.prototype.hasOwnProperty.call(
    body,
    "metadata",
  );
  if (
    hasMetadataPatch &&
    body.metadata !== undefined &&
    !isRecord(body.metadata)
  ) {
    return {
      error: {
        status: 400,
        body: errorBody("metadata must be an object when provided"),
      },
    };
  }

  const metadataPatch = isRecord(body.metadata)
    ? withoutWorldDeletion(body.metadata)
    : undefined;
  const hasTopLevelDimensions = Object.prototype.hasOwnProperty.call(
    body,
    "dimensions",
  );
  const hasMetadataDimensions =
    metadataPatch !== undefined &&
    Object.prototype.hasOwnProperty.call(metadataPatch, "dimensions");
  const rawDimensions = hasTopLevelDimensions
    ? body.dimensions
    : metadataPatch?.dimensions;

  if (
    (hasTopLevelDimensions || hasMetadataDimensions) &&
    !isRecord(rawDimensions)
  ) {
    return {
      error: {
        status: 400,
        body: errorBody("dimensions must be an object when provided"),
      },
    };
  }

  const mergedMetadata = {
    ...existingMetadata,
    ...metadataPatch,
  };
  if (existingMetadata !== undefined) {
    for (const key of ["source", "storage", "packageDigest"]) {
      if (Object.hasOwn(existingMetadata, key))
        mergedMetadata[key] = existingMetadata[key];
      else delete mergedMetadata[key];
    }
  }

  if (hasTopLevelDimensions || hasMetadataDimensions) {
    const validation = validateDimensions(rawDimensions);
    if (!validation.valid) {
      return {
        error: {
          status: 422,
          body: errorBody("Invalid dimensions", { details: validation.errors }),
        },
      };
    }
    const normalizedDimensions = validation.data as Record<string, unknown>;
    mergedMetadata.dimensions = normalizedDimensions;
    return {
      metadata:
        Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
      changedDimensionKeys: Object.keys(normalizedDimensions),
    };
  }

  return {
    metadata:
      Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
  };
}

/**
 * Tell the sessions of a world that its dimension declarations changed. Only
 * a notice: a session keeps the values it has until it syncs.
 */
export async function notifyWorldDimensionsChanged(
  store: DataStore,
  eventBus: EventBus,
  worldId: string,
  changedKeys: readonly string[],
  now: string,
): Promise<void> {
  if (changedKeys.length === 0) return;
  const sessions = await store.listSessions();
  for (const session of sessions.filter((s) => s.worldId === worldId)) {
    eventBus.emit({
      id: crypto.randomUUID(),
      type: "event",
      topic: "system",
      payload: {
        _subTopic: "system",
        _subType: "world.dimensions.changed",
        worldId,
        changedKeys: [...changedKeys],
      },
      sessionId: session.id,
      sessionIncarnation: publicSessionIncarnation(session),
      timestamp: now,
    });
  }
}
