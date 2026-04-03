import { Hono } from "hono";
import type { CharacterCreateInput, CharacterType } from "@covel/shared";
import type { ServerStore } from "../store/types.js";

export function createCharactersRoute(store: ServerStore) {
  const route = new Hono();

  route.get("/", async (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
      return c.json({ code: "INVALID_REQUEST", message: "sessionId query parameter required" }, 400);
    }
    return c.json(await store.getSessionCharacters(sessionId));
  });

  route.get("/:id", async (c) => {
    const id = c.req.param("id");
    const character = await store.getCharacter(id);
    if (!character) {
      return c.json({ code: "NOT_FOUND", message: "Character not found" }, 404);
    }
    return c.json(character);
  });

  route.post("/", async (c) => {
    let body: {
      sessionId?: string;
      name?: string;
      type?: CharacterType;
      description?: string;
      fields?: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON", message: "Malformed JSON body" }, 400);
    }
    if (!body.sessionId || !body.name) {
      return c.json({ code: "INVALID_REQUEST", message: "sessionId and name are required" }, 400);
    }
    const input: CharacterCreateInput = {
      name: body.name,
      type: body.type,
      description: body.description,
      fields: body.fields,
    };
    const character = await store.createCharacter(body.sessionId, input);
    return c.json(character, 201);
  });

  route.patch("/:id", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON", message: "Malformed JSON body" }, 400);
    }
    const VALID_CHARACTER_TYPES = ["player", "npc", "companion"] as const;
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.type === "string") {
      if (!(VALID_CHARACTER_TYPES as readonly string[]).includes(body.type)) {
        return c.json({ code: "INVALID_REQUEST", message: `type must be one of: ${VALID_CHARACTER_TYPES.join(", ")}` }, 400);
      }
      patch.type = body.type;
    }
    if (typeof body.description === "string") patch.description = body.description;
    if (typeof body.portrait === "string") patch.portrait = body.portrait;
    if (body.fields && typeof body.fields === "object") patch.fields = body.fields;
    if (body.extensions && typeof body.extensions === "object") patch.extensions = body.extensions;
    const character = await store.updateCharacter(id, patch);
    if (!character) {
      return c.json({ code: "NOT_FOUND", message: "Character not found" }, 404);
    }
    return c.json(character);
  });

  return route;
}
