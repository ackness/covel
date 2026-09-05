import {
  resolveI18nText,
  type WorldCreateRequest,
  type WorldPatchRequest,
} from "@covel/shared";
import type { WorldRecord } from "@covel/store/browser-sync";
import i18n from "i18next";
import * as api from "../api.js";
import { ApiError, isNotFound } from "../api/request.js";

function serverWorldRequest(world: WorldRecord): WorldCreateRequest {
  return {
    id: world.id,
    name: resolveI18nText(world.name, i18n.language) || world.id,
    description: resolveI18nText(world.description, i18n.language) ?? undefined,
    lore: world.lore
      ? (resolveI18nText(world.lore, i18n.language) ?? undefined)
      : undefined,
    tags: world.tags ? [...world.tags] : undefined,
    locale: world.locale,
    dimensions: world.dimensions,
    metadata: world.metadata ? { ...world.metadata } : undefined,
    createdAt: world.createdAt,
  };
}

function serverWorldPatch(world: WorldRecord): WorldPatchRequest {
  const {
    id: _id,
    createdAt: _createdAt,
    ...patch
  } = serverWorldRequest(world);
  return patch;
}

/** Keep browser locale maps intact while using resolved strings on the wire. */
export function serverCheckpointWorld(world: WorldRecord): WorldRecord {
  const input = serverWorldRequest(world);
  return {
    id: input.id ?? world.id,
    name: input.name,
    description: input.description ?? "",
    lore: input.lore,
    tags: input.tags,
    locale: input.locale,
    dimensions: input.dimensions as WorldRecord["dimensions"],
    metadata: input.metadata,
    createdAt: input.createdAt ?? world.createdAt,
    updatedAt: world.updatedAt,
  };
}

/** Prepare the world for planning or restoring a browser session. */
export async function syncWorldToServer(world: WorldRecord): Promise<void> {
  try {
    await api.getWorld(world.id, { silentErrors: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await api.createWorld(serverWorldRequest(world));
    return;
  }

  try {
    await api.updateWorld(world.id, serverWorldPatch(world), {
      silentStatuses: [401],
    });
  } catch (error) {
    // Shared deployments let session owners use an existing catalog world.
    // Only an operator may change it; checkpoint hydration preserves that row.
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      error.code === "operator_token_required"
    ) {
      return;
    }
    if (isNotFound(error)) {
      await api.createWorld(serverWorldRequest(world));
      return;
    }
    throw error;
  }
}
