import { Hono } from "hono";
import type { CharacterCreateInput, CharacterType } from "@covel/shared";
import type { MemoryStore } from "../store/memory-store.js";

export function createCharactersRoute(store: MemoryStore) {
  const route = new Hono();

  route.get("/", (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
      return c.json({ code: "INVALID_REQUEST", message: "sessionId query parameter required" }, 400);
    }
    return c.json(store.getSessionCharacters(sessionId));
  });

  route.get("/:id", (c) => {
    const id = c.req.param("id");
    const character = store.getCharacter(id);
    if (!character) {
      return c.json({ code: "NOT_FOUND", message: "Character not found" }, 404);
    }
    return c.json(character);
  });

  route.post("/", async (c) => {
    const body = await c.req.json<{
      sessionId?: string;
      name?: string;
      type?: CharacterType;
      description?: string;
      fields?: Record<string, unknown>;
    }>();
    if (!body.sessionId || !body.name) {
      return c.json({ code: "INVALID_REQUEST", message: "sessionId and name are required" }, 400);
    }
    const input: CharacterCreateInput = {
      name: body.name,
      type: body.type,
      description: body.description,
      fields: body.fields,
    };
    const character = store.createCharacter(body.sessionId, input);
    return c.json(character, 201);
  });

  route.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<Record<string, unknown>>();
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.type === "string") patch.type = body.type;
    if (typeof body.description === "string") patch.description = body.description;
    if (typeof body.portrait === "string") patch.portrait = body.portrait;
    if (body.fields && typeof body.fields === "object") patch.fields = body.fields;
    if (body.extensions && typeof body.extensions === "object") patch.extensions = body.extensions;
    const character = store.updateCharacter(id, patch);
    if (!character) {
      return c.json({ code: "NOT_FOUND", message: "Character not found" }, 404);
    }
    return c.json(character);
  });

  return route;
}
