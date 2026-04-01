import { Hono } from "hono";
import type { MemoryStore } from "../store/memory-store.js";

export function createWorldsRoute(store: MemoryStore) {
  const route = new Hono();

  route.get("/", (c) => {
    return c.json(store.listWorlds());
  });

  route.post("/", async (c) => {
    const body = await c.req.json<{ name?: string; description?: string; lore?: string; tags?: string[] }>();
    if (!body.name || !body.description) {
      return c.json({ code: "INVALID_REQUEST", message: "name and description are required" }, 400);
    }
    const world = store.createWorld(body.name, body.description, {
      lore: body.lore,
      tags: body.tags,
    });
    return c.json(world, 201);
  });

  return route;
}
