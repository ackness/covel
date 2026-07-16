/**
 * API Event routes — emit.
 *
 * POST /emit — External event injection into the EventBus
 */

import { Hono } from "hono";
import type { EventBus } from "@covel/events";
import type { DataStore } from "@covel/store";
import type { CovelMessage } from "@covel/shared";
import { isEnvTruthy, readRuntimeEnv } from "@covel/shared";
import { errorBody } from "../../api-error.js";
import { checkSessionOwnerById } from "./session/session-guard.js";

type Env = {
  Variables: {
    eventBus: EventBus;
    store: DataStore;
  };
};

export const eventRoutes = new Hono<Env>();

// POST /events/emit — External event injection (debug/dev only)
eventRoutes.post("/emit", async (c) => {
  // Gate behind ENABLE_DEBUG_PAGE or non-production to prevent arbitrary event injection
  const debugEnabled = isEnvTruthy("ENABLE_DEBUG_PAGE");
  const isProduction = readRuntimeEnv().nodeEnv === "production";
  if (isProduction && !debugEnabled) {
    return c.json(errorBody("Event injection is disabled in production"), 403);
  }

  const eventBus = c.get("eventBus");
  const body = await c.req.json<{
    topic?: string;
    payload?: Record<string, unknown>;
    sessionId?: string;
    targetRuntime?: string;
  }>();

  if (!body.topic || !body.sessionId) {
    return c.json(errorBody("topic and sessionId are required"), 400);
  }

  // Audit 2026-07-16 L-3: on hosted tiers, gate event injection on the target
  // session's owner token so a non-production demo boot can't accept arbitrary
  // cross-session events. Strict no-op on self/desktop (unenforced tiers).
  const denied = await checkSessionOwnerById(c, c.get("store"), body.sessionId);
  if (denied) return denied;

  const message: CovelMessage = {
    id: crypto.randomUUID(),
    type: "event",
    topic: body.topic,
    payload: body.payload ?? {},
    sessionId: body.sessionId,
    targetRuntime: body.targetRuntime,
    timestamp: new Date().toISOString(),
  };

  eventBus.emit(message);
  return c.json({ id: message.id, emitted: true });
});
