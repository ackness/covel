// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createHostGuardMiddleware } from "../../src/middleware/host-guard.js";
import { createForeignRequestGuardMiddleware } from "../../src/middleware/foreign-request-guard.js";
import { createOriginGuardMiddleware } from "../../src/middleware/origin-guard.js";

const SERVER = "http://127.0.0.1:3001";
function harness() {
  const calls: string[] = [];
  const app = new Hono();
  const allowed = (origin: string) => origin === "http://localhost:5173";
  app.use("*", secureHeaders());
  app.use(
    "*",
    createHostGuardMiddleware({ checkHost: true, allowedHosts: [] }),
  );
  app.use("*", createForeignRequestGuardMiddleware());
  app.use("*", cors({ origin: (origin) => (allowed(origin) ? origin : null) }));
  app.use("*", createOriginGuardMiddleware(allowed));
  app.all("*", (c) => {
    calls.push(c.req.path);
    return c.json({ ok: true }, c.req.method === "POST" ? 201 : 200);
  });
  return { app, calls };
}

describe("foreign API requests", () => {
  it.each(["GET", "POST", "OPTIONS"])(
    "refuses opaque origins for %s before CORS",
    async (method) => {
      const { app, calls } = harness();
      const response = await app.request(`${SERVER}/api/sessions`, {
        method,
        headers: {
          Origin: "null",
          "Content-Type": "text/plain",
          ...(method === "OPTIONS"
            ? { "Access-Control-Request-Method": "POST" }
            : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "foreign_request_refused",
      });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(calls).toEqual([]);
    },
  );
  it.each(["iframe", "frame", "embed", "object"])(
    "refuses %s navigations",
    async (dest) => {
      const { app, calls } = harness();
      const response = await app.request(`${SERVER}/api/sessions`, {
        headers: { "Sec-Fetch-Dest": dest },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(calls).toEqual([]);
    },
  );
  it.each(["empty", "image", "audio", "video", "document", undefined])(
    "allows %s requests",
    async (dest) => {
      const { app, calls } = harness();
      const response = await app.request(`${SERVER}/api/sessions`, {
        headers: dest ? { "Sec-Fetch-Dest": dest } : {},
      });
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
    },
  );
  it.each(["http://localhost:5173", SERVER])(
    "allows trusted origin %s",
    async (origin) => {
      const { app } = harness();
      for (const method of ["GET", "POST"]) {
        expect(
          (
            await app.request(`${SERVER}/api/sessions`, {
              method,
              headers: { Origin: origin },
            })
          ).status,
        ).toBe(method === "POST" ? 201 : 200);
      }
    },
  );
  it.each([
    "/plugin-assets/p/d/index.html",
    "/plugin-frame.html",
    "/",
    "/apiary",
  ])("does not gate %s", async (path) => {
    const { app } = harness();
    expect(
      (
        await app.request(`${SERVER}${path}`, {
          headers: { Origin: "null", "Sec-Fetch-Dest": "iframe" },
        })
      ).status,
    ).toBe(200);
  });
  it.each(["/api", "/api/"])("gates %s itself", async (path) => {
    const { app, calls } = harness();
    expect(
      (await app.request(`${SERVER}${path}`, { headers: { Origin: " NuLl " } }))
        .status,
    ).toBe(403);
    expect(calls).toEqual([]);
  });
});
