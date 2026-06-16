/**
 * API Lorebook routes — read + minimal mutation for session-scoped lorebook entries.
 *
 * Session-level lorebook entries live in the framework's lorebook table and are
 * written by plugins via the proposal commit pipeline. This route group exposes
 * them read-only to the player UI, plus two minimal mutations (toggle enabled,
 * delete) so players can mute or remove individual entries.
 *
 * Framework-owned: not tied to any specific plugin. The Lorebook right-panel
 * tab in apps/web consumes this endpoint.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DataStore } from "@covel/store";
import { resolveSessionParam } from "./session/session-guard.js";
import { errorBody } from "../../api-error.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const lorebookRoutes = new Hono<Env>();

const entryBodySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/),
  pluginId: z.string().min(1).max(128).optional(),
  content: z.string().min(1).max(65_536),
  keys: z.array(z.string().max(128)).max(64).optional(),
  strategy: z.enum(["constant", "selective"]).optional(),
  position: z.string().min(1).max(64).optional(),
  insertionOrder: z.number().finite().optional(),
  enabled: z.boolean().optional(),
  extra: z.unknown().optional(),
});

type EntryBody = z.infer<typeof entryBodySchema>;

// GET /sessions/:id/lorebook
lorebookRoutes.get("/:id/lorebook", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const entries = await store.listSessionLorebookEntries(sessionId);
  return c.json({ entries });
});

// POST /sessions/:id/lorebook
lorebookRoutes.post("/:id/lorebook", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const raw = await c.req.json<unknown>().catch(() => null);
  const parsed = entryBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(errorBody("Invalid lorebook entry body"), 400);
  }

  const now = new Date().toISOString();
  const entry = toLorebookRecord(sessionId, parsed.data, now, now);
  await store.upsertLorebookEntries([entry]);
  return c.json({ entry }, 201);
});

// PUT /sessions/:id/lorebook/:entryId
lorebookRoutes.put("/:id/lorebook/:entryId", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const entryId = c.req.param("entryId");
  const raw = await c.req.json<unknown>().catch(() => null);
  const parsed = entryBodySchema.safeParse({
    ...(raw as Record<string, unknown>),
    id: entryId,
  });
  if (!parsed.success) {
    return c.json(errorBody("Invalid lorebook entry body"), 400);
  }

  const existing = (await store.listSessionLorebookEntries(sessionId)).find(
    (e) => e.id === entryId,
  );
  const now = new Date().toISOString();
  const entry = toLorebookRecord(
    sessionId,
    parsed.data,
    existing?.createdAt ?? now,
    now,
    existing,
  );
  await store.upsertLorebookEntries([entry]);
  return c.json({ entry });
});

// PATCH /sessions/:id/lorebook/:entryId
// Currently supports toggling `enabled`. The store has no partial-update
// method, so this re-upserts the existing record with the new flag.
lorebookRoutes.patch("/:id/lorebook/:entryId", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const entryId = c.req.param("entryId");
  const raw = await c.req.json<unknown>().catch(() => null);
  const bodySchema = z.object({ enabled: z.boolean() });
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      errorBody("Invalid body: expected { enabled: boolean }"),
      400,
    );
  }

  const existing = (await store.listSessionLorebookEntries(sessionId)).find(
    (e) => e.id === entryId,
  );
  if (!existing) {
    return c.json(errorBody("Lorebook entry not found"), 404);
  }

  const now = new Date().toISOString();
  await store.upsertLorebookEntries([
    {
      ...existing,
      enabled: parsed.data.enabled,
      updatedAt: now,
    },
  ]);

  return c.json({ success: true, entryId, enabled: parsed.data.enabled });
});

// DELETE /sessions/:id/lorebook/:entryId
lorebookRoutes.delete("/:id/lorebook/:entryId", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const entryId = c.req.param("entryId");
  const existing = (await store.listSessionLorebookEntries(sessionId)).find(
    (e) => e.id === entryId,
  );
  if (!existing) {
    return c.json(errorBody("Lorebook entry not found"), 404);
  }

  await store.deleteLorebookEntry(sessionId, entryId);
  return c.json({ success: true });
});

function toLorebookRecord(
  sessionId: string,
  body: EntryBody,
  createdAt: string,
  updatedAt: string,
  existing?: {
    readonly pluginId: string;
    readonly keys: readonly string[];
    readonly strategy: "constant" | "selective";
    readonly position: string;
    readonly insertionOrder: number;
    readonly enabled: boolean;
    readonly extra?: unknown;
  },
) {
  return {
    id: body.id,
    sessionId,
    pluginId: body.pluginId ?? existing?.pluginId ?? "manual-lorebook",
    keys: body.keys ?? existing?.keys ?? [],
    content: body.content,
    strategy: body.strategy ?? existing?.strategy ?? "constant",
    position: body.position ?? existing?.position ?? "after_plugin",
    insertionOrder: body.insertionOrder ?? existing?.insertionOrder ?? 500,
    enabled: body.enabled ?? existing?.enabled ?? true,
    ...(body.extra !== undefined
      ? { extra: body.extra }
      : existing?.extra !== undefined
        ? { extra: existing.extra }
        : {}),
    createdAt,
    updatedAt,
  };
}
