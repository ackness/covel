// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createHostGuardMiddleware } from "../../src/middleware/host-guard.js";

function app(
  env: { deploymentTier: string; allowedHosts: string[] } = {
    deploymentTier: "self",
    allowedHosts: [],
  },
) {
  const writes: string[] = [];
  const hono = new Hono();
  hono.use("*", createHostGuardMiddleware(env));
  hono.get("/api/sessions", (c) => c.json({ items: [] }));
  hono.post("/api/sessions", async (c) => {
    writes.push(await c.req.text());
    return c.json({ ok: true }, 201);
  });
  return { hono, writes };
}

const get = (hono: Hono, host?: string) =>
  hono.request("http://127.0.0.1:3001/api/sessions", {
    headers: host === undefined ? {} : { Host: host },
  });

const post = (hono: Hono, host: string) =>
  hono.request("http://127.0.0.1:3001/api/sessions", {
    method: "POST",
    headers: { Host: host, "Content-Type": "text/plain" },
    body: "{}",
  });

describe("host guard", () => {
  it.each(["127.0.0.1:3001", "localhost:3001", "[::1]:3001", "LOCALHOST"])(
    "answers a loopback name (%s)",
    async (host) => {
      const { hono, writes } = app();
      expect((await get(hono, host)).status).toBe(200);
      expect((await post(hono, host)).status).toBe(201);
      expect(writes).toHaveLength(1);
    },
  );

  it("answers the Vite dev proxy, which forwards its own port", async () => {
    expect((await get(app().hono, "localhost:5173")).status).toBe(200);
  });

  // A DNS-rebound page sends its own name: the browser sees a same-origin
  // request, so neither CORS nor the origin guard stops it.
  it("refuses a rebound name on reads and writes", async () => {
    const { hono, writes } = app();
    const read = await get(hono, "rebind.example:3001");
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({ code: "host_not_allowed" });
    const write = await post(hono, "rebind.example:3001");
    expect(write.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it.each(["localhost.rebind.example", "127.0.0.1.rebind.example", "a/b"])(
    "refuses a look-alike or malformed name (%s)",
    async (host) => {
      expect((await get(app().hono, host)).status).toBe(403);
    },
  );

  it("refuses a LAN address unless it is listed", async () => {
    expect((await get(app().hono, "192.168.1.20:3001")).status).toBe(403);
  });

  it("answers the names listed in COVEL_ALLOWED_HOSTS", async () => {
    const { hono } = app({
      deploymentTier: "self",
      allowedHosts: ["Covel.Home.Test", "192.168.1.20:3001"],
    });
    expect((await get(hono, "covel.home.test")).status).toBe(200);
    expect((await get(hono, "192.168.1.20:8080")).status).toBe(200);
    expect((await get(hono, "other.home.test")).status).toBe(403);
  });

  it("lets a request without a Host header through", async () => {
    expect((await get(app().hono)).status).toBe(200);
  });

  it.each(["demo", "commercial"])(
    "is off on the %s tier, where every route checks a token",
    async (deploymentTier) => {
      const { hono } = app({ deploymentTier, allowedHosts: [] });
      expect((await get(hono, "covel.onrender.example")).status).toBe(200);
    },
  );
});
