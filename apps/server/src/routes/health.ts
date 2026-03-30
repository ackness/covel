import { Hono } from "hono";

export const healthRoute = new Hono();

healthRoute.get("/", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.0.0",
  });
});
