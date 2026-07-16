/**
 * World CRUD routes — list, get, create, partial update, delete.
 */

import { Hono } from "hono";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { WorldRecord } from "@covel/store";
import { errorBody } from "../../../api-error.js";
import { resolveContainedPath } from "../../../world-data/safe-path.js";
import { checkHostedOperator } from "../session/session-guard.js";
import { type WorldEnv, resolveWorldMetadata } from "./shared.js";

export const worldCrudRoutes = new Hono<WorldEnv>();

// GET /worlds
worldCrudRoutes.get("/", async (c) => {
  const store = c.get("store");
  const worlds = await store.listWorlds();
  return c.json({ items: worlds });
});

// GET /worlds/:id
worldCrudRoutes.get("/:id", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");
  const world = await store.getWorld(id);
  if (!world) {
    return c.json(errorBody("World not found"), 404);
  }
  return c.json(world);
});

// POST /worlds
worldCrudRoutes.post("/", async (c) => {
  const denied = checkHostedOperator(c);
  if (denied) return denied;
  const store = c.get("store");
  const body = await c.req.json<Record<string, unknown>>();

  if (!body.id || typeof body.id !== "string") {
    return c.json(errorBody("id (string) is required"), 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json(errorBody("name (string) is required"), 400);
  }

  const now = new Date().toISOString();
  const metadataResult = resolveWorldMetadata(body);
  if (metadataResult.error) {
    return c.json(metadataResult.error.body, metadataResult.error.status);
  }
  const record: WorldRecord = {
    id: body.id,
    name: body.name,
    description: typeof body.description === "string" ? body.description : "",
    lore: typeof body.lore === "string" ? body.lore : undefined,
    tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
    locale: typeof body.locale === "string" ? body.locale : undefined,
    metadata: metadataResult.metadata,
    createdAt: typeof body.createdAt === "string" ? body.createdAt : now,
    updatedAt: now,
  };

  await store.upsertWorld(record);
  return c.json(record);
});

// PATCH /worlds/:id — partial update (overlay lore, tags, etc.)
worldCrudRoutes.patch("/:id", async (c) => {
  const denied = checkHostedOperator(c);
  if (denied) return denied;
  const store = c.get("store");
  const id = c.req.param("id");
  const existing = await store.getWorld(id);
  if (!existing) {
    return c.json(errorBody("World not found"), 404);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const now = new Date().toISOString();
  const metadataResult = resolveWorldMetadata(body, existing.metadata);
  if (metadataResult.error) {
    return c.json(metadataResult.error.body, metadataResult.error.status);
  }

  const updated: WorldRecord = {
    ...existing,
    name: typeof body.name === "string" ? body.name : existing.name,
    description:
      typeof body.description === "string"
        ? body.description
        : existing.description,
    lore: typeof body.lore === "string" ? body.lore : existing.lore,
    tags: Array.isArray(body.tags) ? (body.tags as string[]) : existing.tags,
    locale: typeof body.locale === "string" ? body.locale : existing.locale,
    metadata: metadataResult.metadata,
    updatedAt: now,
  };

  await store.upsertWorld(updated);
  return c.json(updated);
});

// DELETE /worlds/:id
worldCrudRoutes.delete("/:id", async (c) => {
  const denied = checkHostedOperator(c);
  if (denied) return denied;
  const store = c.get("store");
  const id = c.req.param("id");
  const world = await store.getWorld(id);
  if (!world) {
    return c.json(errorBody("World not found"), 404);
  }
  const meta = world.metadata as Record<string, unknown> | undefined;
  if (meta?.source === "file") {
    return c.json(errorBody("Built-in worlds cannot be deleted"), 403);
  }
  if (meta?.source === "generated-file") {
    const worldsDirs = c.get("worldsDirs") ?? [];
    for (const worldsDir of worldsDirs) {
      const worldPath = await resolveContainedPath(worldsDir, id, {
        rejectSymlinks: true,
      });
      if (worldPath && path.basename(worldPath) === id) {
        await rm(worldPath, { recursive: true, force: true });
        break;
      }
    }
  }
  await store.deleteWorld(id);
  return c.json({ success: true });
});
