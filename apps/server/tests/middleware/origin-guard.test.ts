// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createOriginGuardMiddleware } from "../../src/middleware/origin-guard.js";

const ALLOWED = "http://localhost:5173";
const SERVER = "http://127.0.0.1:3001";

/** The composition root's order: CORS first, then the write guard. */
function app() {
  const writes: string[] = [];
  const isAllowed = (origin: string) => origin === ALLOWED;
  const hono = new Hono();
  hono.use(
    "*",
    cors({ origin: (origin) => (isAllowed(origin) ? origin : null) }),
  );
  hono.use("*", createOriginGuardMiddleware(isAllowed));
  hono.post("/api/sessions", async (c) => {
    writes.push(await c.req.text());
    return c.json({ ok: true }, 201);
  });
  hono.get("/api/sessions", (c) => c.json({ items: [] }));
  return { hono, writes };
}

const post = (
  hono: Hono,
  headers: Record<string, string>,
  url = `${SERVER}/api/sessions`,
) =>
  hono.request(url, {
    method: "POST",
    // A "simple" request: no preflight, so the handler is the only gate.
    headers: { "Content-Type": "text/plain", ...headers },
    body: JSON.stringify({ id: "s" }),
  });

describe("origin guard", () => {
  it.each([
    ["another site", "https://untrusted.example"],
    ["an opaque origin", "null"],
  ])(
    "refuses a write sent from %s before it reaches a route",
    async (_, origin) => {
      const { hono, writes } = app();
      const response = await post(hono, { Origin: origin });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "origin_not_allowed",
      });
      expect(writes).toEqual([]);
    },
  );

  it.each([
    ["no Origin (a non-browser client)", {}, undefined],
    ["an allow-listed origin", { Origin: ALLOWED }, undefined],
    [
      "the page the server serves",
      { Origin: "http://play.example:3001" },
      "http://play.example:3001/api/sessions",
    ],
    [
      "the page behind a proxy that forwards the public host",
      { Origin: "https://play.example", "X-Forwarded-Host": "play.example" },
      undefined,
    ],
  ])("lets a write through with %s", async (_, headers, url) => {
    const { hono, writes } = app();
    expect((await post(hono, headers, url)).status).toBe(201);
    expect(writes).toHaveLength(1);
  });

  it("does not gate reads; CORS still withholds their response", async () => {
    const { hono } = app();
    const response = await hono.request(`${SERVER}/api/sessions`, {
      headers: { Origin: "https://untrusted.example" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
