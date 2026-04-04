import { Hono } from "hono";

export const healthRoute = new Hono();

healthRoute.get("/", (c) => {
  const storeBackend = process.env.STORE_BACKEND ?? "memory";
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.0.0",
    storeBackend: storeBackend === "pg" && process.env.DATABASE_URL ? "pg" : "memory",
  });
});
