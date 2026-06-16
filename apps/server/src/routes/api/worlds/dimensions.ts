/**
 * World dimension export/import routes.
 *
 *   GET  /worlds/:id/dimensions/export — download dimensions as YAML or JSON.
 *   POST /worlds/:id/dimensions/import — replace dimensions from a JSON body.
 */

import { Hono } from "hono";
import { stringify as stringifyYaml } from "yaml";
import { validateDimensions } from "@covel/shared";
import type { WorldRecord } from "@covel/store";
import { type WorldEnv } from "./shared.js";

export const worldDimensionRoutes = new Hono<WorldEnv>();

// GET /worlds/:id/dimensions/export — download dimensions as YAML
worldDimensionRoutes.get("/:id/dimensions/export", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");
  const world = await store.getWorld(id);
  if (!world) {
    return c.json({ error: "World not found" }, 404);
  }

  const meta = world.metadata as Record<string, unknown> | undefined;
  const dimensions = meta?.dimensions ?? {};

  const format = c.req.query("format") ?? "yaml";

  if (format !== "yaml" && format !== "json") {
    return c.json({ error: 'Invalid format. Use "yaml" or "json".' }, 400);
  }

  if (format === "json") {
    return c.json(dimensions, 200, {
      "Content-Disposition": `attachment; filename="${id}-dimensions.json"`,
    });
  }

  // Default: YAML
  const yaml = stringifyYaml(dimensions, { lineWidth: 120 });
  return c.text(yaml, 200, {
    "Content-Type": "application/x-yaml; charset=utf-8",
    "Content-Disposition": `attachment; filename="${id}-dimensions.yaml"`,
  });
});

// POST /worlds/:id/dimensions/import — import dimensions from JSON body
worldDimensionRoutes.post("/:id/dimensions/import", async (c) => {
  const store = c.get("store");
  const eventBus = c.get("eventBus");
  const id = c.req.param("id");

  const existing = await store.getWorld(id);
  if (!existing) {
    return c.json({ error: "World not found" }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const dimensions = body.dimensions;

  if (!dimensions || typeof dimensions !== "object") {
    return c.json({ error: "dimensions (object) is required" }, 400);
  }

  // Validate against worldDimensionsSchema
  const validation = validateDimensions(dimensions);
  if (!validation.valid) {
    return c.json(
      { error: "Invalid dimensions", details: validation.errors },
      422,
    );
  }

  const now = new Date().toISOString();
  const meta = (existing.metadata as Record<string, unknown>) ?? {};
  const updated: WorldRecord = {
    ...existing,
    metadata: { ...meta, dimensions: validation.data },
    updatedAt: now,
  };

  await store.upsertWorld(updated);

  // Notify active sessions
  const sessions = await store.listSessions();
  const affected = sessions.filter((s) => s.worldId === id);
  for (const session of affected) {
    eventBus.emit({
      id: crypto.randomUUID(),
      type: "event",
      topic: "system",
      payload: {
        _subTopic: "system",
        _subType: "world.dimensions.changed",
        worldId: id,
        changedKeys: Object.keys(dimensions),
      },
      sessionId: session.id,
      timestamp: now,
    });
  }

  return c.json(updated);
});
