import { Hono } from "hono";

/** Stable identifier for this server process — changes on every restart. */
const bootId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const healthRoute = new Hono();

healthRoute.get("/", (c) => {
  const storeBackend = process.env.STORE_BACKEND ?? "memory";
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.0.0",
    storeBackend: storeBackend === "pg" && process.env.DATABASE_URL ? "pg" : "memory",
    bootId,
  });
});
