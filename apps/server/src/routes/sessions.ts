import { Hono } from "hono";
import type { ServerStore } from "../store/types.js";

export function createSessionsRoute(store: ServerStore) {
  const route = new Hono();

  route.get("/", async (c) => {
    const worldId = c.req.query("worldId");
    if (!worldId) {
      return c.json({ code: "INVALID_REQUEST", message: "worldId query parameter required" }, 400);
    }
    return c.json(await store.listSessions(worldId));
  });

  route.get("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    // Avoid matching sub-paths like /:sessionId/messages
    if (sessionId.includes("/")) return c.notFound();
    const session = await store.getSession(sessionId);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    return c.json(session);
  });

  route.post("/", async (c) => {
    let body: {
      id?: string;
      worldId?: string;
      presetId?: string;
      taskBindings?: Record<string, string>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON", message: "Malformed JSON body" }, 400);
    }
    if (!body.worldId) {
      return c.json({ code: "INVALID_REQUEST", message: "worldId is required" }, 400);
    }
    // Validate taskBindings values are all strings
    if (body.taskBindings && typeof body.taskBindings === "object") {
      for (const [key, val] of Object.entries(body.taskBindings)) {
        if (typeof val !== "string") {
          return c.json({ code: "INVALID_REQUEST", message: `taskBindings.${key} must be a string` }, 400);
        }
      }
    }
    const session = await store.createSession({
      id: body.id,
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
      const tb = body.taskBindings as Record<string, unknown>;
      const allStrings = Object.values(tb).every((v) => typeof v === "string");
      if (allStrings) {
        patch.taskBindings = tb as Record<string, string>;
      }
    }
    return patch;
  }

  route.patch("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON", message: "Malformed JSON body" }, 400);
    }
    const patch = parseSessionPatch(body);
    const session = await store.updateSession(sessionId, patch);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    return c.json(session);
  });

  route.put("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON", message: "Malformed JSON body" }, 400);
    }
    const patch = parseSessionPatch(body);
    const session = await store.updateSession(sessionId, patch);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    return c.json(session);
  });

  route.delete("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const deleted = await store.deleteSession(sessionId);
    if (!deleted) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    return c.json({ ok: true });
  });

  route.get("/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await store.getSession(sessionId);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    return c.json(await store.listMessages(sessionId));
  });

  route.get("/:sessionId/state-patches", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await store.getSession(sessionId);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    return c.json(await store.listStatePatches(sessionId));
  });

  // ── State Snapshots (post-commit full state) ────────────────────

  route.get("/:sessionId/state-snapshot", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await store.getSession(sessionId);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    const snapshot = await store.getStateSnapshot(sessionId);
    if (!snapshot) {
      return c.json(null);
    }
    return c.json(snapshot);
  });

  route.put("/:sessionId/state-snapshot", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await store.getSession(sessionId);
    if (!session) {
      return c.json({ code: "NOT_FOUND", message: "Session not found" }, 404);
    }
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON", message: "Malformed JSON body" }, 400);
    }
    await store.saveStateSnapshot(sessionId, body);
    return c.json({ ok: true });
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
