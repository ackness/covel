/**
 * Player turn-control endpoints (roadmap W4):
 *
 *   POST /api/sessions/:id/steer  { message }  — interject into the active turn
 *   POST /api/sessions/:id/abort                — abort the active turn
 *
 * Both 409 when the session has no in-flight turn (the client falls back to
 * a normal send / no-op). Steered messages are also persisted to the
 * messages table so they appear in history for subsequent turns.
 */

import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { errorBody } from "../../api-error.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import {
  abortActiveTurn,
  retractSteering,
  steerActiveTurn,
} from "./turn-control.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const turnControlRoutes = new Hono<Env>();

turnControlRoutes.post("/:id/steer", rateLimiter({ max: 30 }), async (c) => {
  const sessionId = c.req.param("id");
  const store = c.get("store");
  const body = await c.req
    .json<{ message?: unknown }>()
    .catch(() => null as { message?: unknown } | null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    return c.json(errorBody("message (non-empty string) is required"), 400);
  }
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(errorBody("Session not found"), 404);
  }

  const steered = steerActiveTurn(sessionId, message);
  if (!steered) {
    return c.json(errorBody("No active turn to steer"), 409);
  }

  // Persist so the interjection is part of history for subsequent turns —
  // the live injection into the current loop happens via the steering queue.
  try {
    await store.addMessage({
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: message,
      metadata: { turnId: steered.turnId, steered: true },
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Keep queue and persistence consistent: the client sees a failure and
    // will retry, so retract the queued copy or the retry double-injects.
    retractSteering(sessionId, message);
    throw err;
  }

  return c.json({ ok: true, turnId: steered.turnId });
});

turnControlRoutes.post("/:id/abort", rateLimiter({ max: 30 }), async (c) => {
  const sessionId = c.req.param("id");
  const store = c.get("store");
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(errorBody("Session not found"), 404);
  }

  const aborted = abortActiveTurn(sessionId);
  if (!aborted) {
    return c.json(errorBody("No active turn to abort"), 409);
  }
  return c.json({ ok: true, turnId: aborted.turnId });
});
