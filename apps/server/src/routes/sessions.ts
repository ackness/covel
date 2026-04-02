import { Hono } from "hono";
import type { MemoryStore } from "../store/memory-store.js";

export function createSessionsRoute(store: MemoryStore) {
  const route = new Hono();

  route.get("/", (c) => {
    const worldId = c.req.query("worldId");
    if (!worldId) {
      return c.json({ code: "INVALID_REQUEST", message: "worldId query parameter required" }, 400);
    }
    return c.json(store.listSessions(worldId));
  });

  route.post("/", async (c) => {
    const body = await c.req.json<{
      worldId?: string;
      presetId?: string;
      taskBindings?: Record<string, string>;
    }>();
    if (!body.worldId) {
      return c.json({ code: "INVALID_REQUEST", message: "worldId is required" }, 400);
    }
    const session = store.createSession({
      worldId: body.worldId,
      presetId: body.presetId,
      taskBindings: body.taskBindings,
    });
    return c.json(session, 201);
  });

  function parseSessionPatch(body: Record<string, unknown>) {
    const VALID_STATUSES = ["active", "waiting_for_input", "archived"] as const;
    const VALID_PHASES = ["init", "character_creation", "playing", "ended"] as const;
    const patch: {
      status?: "active" | "waiting_for_input" | "archived";
      phase?: "init" | "character_creation" | "playing" | "ended";
      presetId?: string;
      taskBindings?: Record<string, string>;
    } = {};
    if (typeof body.status === "string" && (VALID_STATUSES as readonly string[]).includes(body.status)) {
      patch.status = body.status as "active" | "waiting_for_input" | "archived";
    }
    if (typeof body.phase === "string" && (VALID_PHASES as readonly string[]).includes(body.phase)) {
      patch.phase = body.phase as "init" | "character_creation" | "playing" | "ended";
    }
    if (typeof body.presetId === "string") patch.presetId = body.presetId;
    if (body.taskBindings && typeof body.taskBindings === "object") {
      patch.taskBindings = body.taskBindings as Record<string, string>;
    }
    return patch;
  }

  route.patch("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<Record<string, unknown>>();
    const patch = parseSessionPatch(body);
    const session = store.updateSession(sessionId, patch);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    return c.json(session);
  });

  route.put("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<Record<string, unknown>>();
    const patch = parseSessionPatch(body);
    const session = store.updateSession(sessionId, patch);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    return c.json(session);
  });

  route.get("/:sessionId/messages", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = store.getSession(sessionId);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    return c.json(store.listMessages(sessionId));
  });

  // Stubs for endpoints the frontend may call
  route.get("/:sessionId/workflow-snapshots", (c) => {
    return c.json([]);
  });

  route.get("/:sessionId/package-state", (c) => {
    return c.json([]);
  });

  return route;
}
