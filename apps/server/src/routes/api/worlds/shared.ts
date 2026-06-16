/**
 * Shared types + helpers for the world route modules (crud / dimensions /
 * data-sync). The world routes were split out of a single 543-line file; this
 * module holds the pieces more than one of them needs.
 */

import { validateDimensions } from "@covel/shared";
import type { DataStore, MediaStore } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";

export type WorldEnv = {
  Variables: {
    store: DataStore;
    eventBus: EventBus;
    pluginRegistry: PluginRegistry;
    mediaStore?: MediaStore;
    worldsDirs?: readonly string[];
    covelHome?: string;
  };
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatWorldEntryContent(key: string, value: unknown): string {
  let body: string;
  try {
    body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  return `[${key}]\n${body}`;
}

export function resolveWorldMetadata(
  body: Record<string, unknown>,
  existingMetadata?: Readonly<Record<string, unknown>>,
): {
  metadata?: Record<string, unknown>;
  changedDimensionKeys?: readonly string[];
  error?: { status: 400 | 422; body: Record<string, unknown> };
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
        body: { error: "metadata must be an object when provided" },
      },
    };
  }

  const metadataPatch = isRecord(body.metadata) ? body.metadata : undefined;
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
        body: { error: "dimensions must be an object when provided" },
      },
    };
  }

  const mergedMetadata = {
    ...existingMetadata,
    ...metadataPatch,
  };

  if (hasTopLevelDimensions || hasMetadataDimensions) {
    const validation = validateDimensions(rawDimensions);
    if (!validation.valid) {
      return {
        error: {
          status: 422,
          body: { error: "Invalid dimensions", details: validation.errors },
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
