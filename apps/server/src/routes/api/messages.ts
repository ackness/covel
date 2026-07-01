/**
 * API Message routes — read-only query endpoints for message history.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DataStore } from "@covel/store";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { resolveSessionParam } from "./session/session-guard.js";
import { errorBody } from "../../api-error.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const messageRoutes = new Hono<Env>();

// Validate the /messages/sync body: `messages` must be an array of well-shaped
// entries with an allowed role. Without this, a non-array `messages` iterated
// junk into history and an arbitrary `role` (e.g. system) was persisted verbatim
// into the prompt-assembled history from untrusted input.
const syncMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  turnId: z.unknown().optional(),
  runtimeId: z.unknown().optional(),
  block: z.unknown().optional(),
  createdAt: z.string().optional(),
});
const syncBodySchema = z.object({
  messages: z.array(syncMessageSchema),
});

// GET /sessions/:id/messages
messageRoutes.get("/:id/messages", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const messages = await store.listMessages(sessionId);
  // Flatten metadata into top-level fields for frontend consumption
  const flattened = messages.map((m) => {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return {
      id: m.id,
      sessionId: m.sessionId,
      role: m.role,
      content: m.content,
      turnId: meta.turnId,
      runtimeId: meta.runtimeId,
      kind: meta.kind,
      block: meta.block,
      createdAt: m.createdAt,
    };
  });
  return c.json(flattened);
});

// POST /sessions/:id/messages/sync — bulk upsert messages (LocalDataService)
messageRoutes.post(
  "/:id/messages/sync",
  rateLimiter({ max: 60 }),
  async (c) => {
    const store = c.get("store");
    const sessionId = c.req.param("id");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const parsed = syncBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        errorBody(
          "Invalid body: expected { messages: [{ role: 'user'|'assistant'|'system'|'tool', content: string }] }",
        ),
        400,
      );
    }
    for (const msg of parsed.data.messages) {
      await store.addMessage({
        id: msg.id ?? crypto.randomUUID(),
        sessionId,
        role: msg.role,
        content: msg.content,
        metadata: {
          turnId: msg.turnId,
          runtimeId: msg.runtimeId,
          block: msg.block,
        },
        createdAt: msg.createdAt ?? new Date().toISOString(),
      });
    }
    return c.json({ ok: true });
  },
);
