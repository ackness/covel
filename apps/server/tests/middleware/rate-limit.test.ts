import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  rateLimiter,
  resolveClientIp,
} from "../../src/middleware/rate-limit.js";

let server: ServerType | undefined;
const savedTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;

afterEach(async () => {
  if (savedTrustedProxyIps === undefined) {
    delete process.env.TRUSTED_PROXY_IPS;
  } else {
    process.env.TRUSTED_PROXY_IPS = savedTrustedProxyIps;
  }
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  });
  server = undefined;
});

async function start(app: Hono): Promise<number> {
  return new Promise((resolve) => {
    server = serve(
      { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
      (info) => resolve((info as AddressInfo).port),
    );
  });
}

describe("rateLimiter X-Forwarded-For resolution", () => {
  it("ignores spoofed leftmost X-Forwarded-For entries and normalizes ::ffff: trusted proxies", async () => {
    process.env.TRUSTED_PROXY_IPS = "::ffff:127.0.0.1, 10.0.0.2";

    const app = new Hono();
    app.use("/limited", rateLimiter({ max: 2 }));
    app.get("/limited", (c) => c.json({ ip: resolveClientIp(c) }));
    const port = await start(app);

    // Three requests from the same real client (203.0.113.5) with different
    // attacker-supplied leftmost entries passing through trusted hop 10.0.0.2.
    const r1 = await fetch(`http://127.0.0.1:${port}/limited`, {
      headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.5, 10.0.0.2" },
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ip: "203.0.113.5" });

    const r2 = await fetch(`http://127.0.0.1:${port}/limited`, {
      headers: { "x-forwarded-for": "198.51.100.2, 203.0.113.5, 10.0.0.2" },
    });
    expect(r2.status).toBe(200);

    const r3 = await fetch(`http://127.0.0.1:${port}/limited`, {
      headers: { "x-forwarded-for": "198.51.100.3, 203.0.113.5, 10.0.0.2" },
    });
    expect(r3.status).toBe(429);

    // A genuinely different client behind the same proxy still gets its own bucket.
    const r4 = await fetch(`http://127.0.0.1:${port}/limited`, {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.2" },
    });
    expect(r4.status).toBe(200);
    expect(await r4.json()).toEqual({ ip: "203.0.113.9" });
  });
});
