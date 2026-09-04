/**
 * World CRUD routes — list, get, create, partial update, delete.
 */

import { Hono } from "hono";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  worldCreateRequestSchema,
  worldPatchRequestSchema,
} from "@covel/shared";
import type { WorldRecord } from "@covel/store";
import { errorBody, okBody, readJsonBody } from "../../../api-error.js";
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
  const parsed = await readJsonBody<Record<string, unknown>>(c);
  if (parsed instanceof Response) return parsed;
  const validated = worldCreateRequestSchema.safeParse(parsed.body);
  if (!validated.success) {
    return c.json(
      errorBody(validated.error.issues[0]?.message ?? "Invalid world request", {
        details: validated.error.issues,
      }),
      400,
    );
  }
  const body = { ...validated.data };
  const id = body.id ?? `world-${globalThis.crypto.randomUUID().slice(0, 8)}`;

  const now = new Date().toISOString();
  const metadataResult = resolveWorldMetadata(body);
  if (metadataResult.error) {
    return c.json(metadataResult.error.body, metadataResult.error.status);
  }
  const record: WorldRecord = {
    id,
    name: body.name,
    description: body.description ?? "",
    lore: body.lore,
    tags: body.tags,
    locale: body.locale,
    metadata: metadataResult.metadata,
    createdAt: body.createdAt ?? now,
    updatedAt: now,
  };

  if (!(await store.createWorld(record))) {
    return c.json(
      errorBody("World already exists", { code: "world_already_exists" }),
      409,
    );
  }
  return c.json(record, 201);
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

  const parsed = await readJsonBody<Record<string, unknown>>(c);
  if (parsed instanceof Response) return parsed;
  const validated = worldPatchRequestSchema.safeParse(parsed.body);
  if (!validated.success) {
    return c.json(
      errorBody(validated.error.issues[0]?.message ?? "Invalid world patch", {
        details: validated.error.issues,
      }),
      400,
    );
  }
  const body = { ...validated.data };
  const now = new Date().toISOString();
  const metadataResult = resolveWorldMetadata(body, existing.metadata);
  if (metadataResult.error) {
    return c.json(metadataResult.error.body, metadataResult.error.status);
  }

  const updated: WorldRecord = {
    ...existing,
    name: body.name ?? existing.name,
    description: body.description ?? existing.description,
    lore: body.lore ?? existing.lore,
    tags: body.tags ?? existing.tags,
    locale: body.locale ?? existing.locale,
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
  return c.json(okBody());
});
