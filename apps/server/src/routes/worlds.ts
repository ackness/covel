import { Hono } from "hono";
import { worldRecordCreateSchema, worldRecordUpdateSchema } from "@covel/shared";
import type { MemoryStore } from "../store/memory-store.js";

export function createWorldsRoute(store: MemoryStore) {
  const route = new Hono();

  route.get("/", (c) => {
    return c.json(store.listWorlds());
  });

  route.get("/:id", (c) => {
    const world = store.getWorld(c.req.param("id"));
    if (!world) {
      return c.json({ code: "NOT_FOUND", message: "World not found" }, 404);
    }
    return c.json(world);
  });

  route.post("/", async (c) => {
    const body = await c.req.json();
    const result = worldRecordCreateSchema.safeParse(body);
    if (!result.success) {
      return c.json(
        { code: "INVALID_REQUEST", message: result.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }
    const { name, description, lore, locale, tags, dimensions } = result.data;
    const world = store.createWorld(name, description, { lore, locale, tags, dimensions });
    return c.json(world, 201);
  });

  route.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = store.getWorld(id);
    if (!existing) {
      return c.json({ code: "NOT_FOUND", message: "World not found" }, 404);
    }
    const body = await c.req.json();
    const result = worldRecordUpdateSchema.safeParse(body);
    if (!result.success) {
      return c.json(
        { code: "INVALID_REQUEST", message: result.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }
    const updated = store.updateWorld(id, result.data);
    return c.json(updated);
  });

  return route;
}
