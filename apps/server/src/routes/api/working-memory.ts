/**
 * API Working Memory routes — CRUD for framework-level cross-session state.
 *
 * Working Memory is session-scoped and isolated by (sessionId, scope, key).
 * Unlike plugin_data, this is framework-owned and injected into every turn's
 * prompt.
 *
 * Security: At T3 deployment, this route group should be placed behind
 * authentication middleware.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DataStore } from "@covel/store";
import { resolveSessionParam } from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const workingMemoryRoutes = new Hono<Env>();

const VALID_SCOPES = new Set(["player", "story", "shared"]);

// GET /sessions/:id/memory-blocks — Returns Letta-style memory blocks (story scope).
// Read-only convenience endpoint for the UI panel.
//
// Path was renamed from `/:id/core-memory` (2026-04-27) to avoid collision with
// the `memory` plugin id and follow the framework-plugin isolation rule.
workingMemoryRoutes.get("/:id/memory-blocks", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const all = await store.listWorkingMemory(sessionId);
  const blocks = all
    .filter((r) => r.scope === "story")
    .map((r) => ({
      label: r.key,
      content:
        typeof r.value === "object" &&
        r.value !== null &&
        "text" in (r.value as Record<string, unknown>)
          ? (r.value as Record<string, unknown>).text
          : r.value,
      updatedAt: r.updatedAt,
    }));

  return c.json({ blocks });
});

// GET /sessions/:id/working-memory
workingMemoryRoutes.get("/:id/working-memory", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const entries = await store.listWorkingMemory(sessionId);
  return c.json({ entries });
});

// PUT /sessions/:id/working-memory/:scope/:key
workingMemoryRoutes.put("/:id/working-memory/:scope/:key", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const scope = c.req.param("scope");
  if (!VALID_SCOPES.has(scope)) {
    return c.json(
      {
        error: `Invalid scope "${scope}". Must be one of: player, story, shared`,
      },
      400,
    );
  }

  const key = c.req.param("key");
  if (!key) {
    return c.json({ error: "Key must not be empty" }, 400);
  }

  const raw = await c.req.json<unknown>();
  const bodySchema = z.object({
    value: z.unknown(),
    schemaRef: z.string().optional(),
  });
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body: value field is required" }, 400);
  }

  if (parsed.data.value === undefined) {
    return c.json({ error: "value must not be undefined" }, 400);
  }

  const now = new Date().toISOString();
  await store.upsertWorkingMemory({
    id: crypto.randomUUID(),
    sessionId,
    key,
    scope: scope as "player" | "story" | "shared",
    value: parsed.data.value,
    schemaRef: parsed.data.schemaRef,
    updatedAt: now,
  });

  return c.json({ success: true, scope, key });
});

// DELETE /sessions/:id/working-memory/:scope/:key
workingMemoryRoutes.delete("/:id/working-memory/:scope/:key", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const scope = c.req.param("scope");
  if (!VALID_SCOPES.has(scope)) {
    return c.json(
      {
        error: `Invalid scope "${scope}". Must be one of: player, story, shared`,
      },
      400,
    );
  }

  const key = c.req.param("key");
  await store.deleteWorkingMemory(
    sessionId,
    scope as "player" | "story" | "shared",
    key,
  );
  return c.json({ success: true });
});
