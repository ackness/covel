// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
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
  hono.patch("/api/worlds/mistport", async (c) => {
    writes.push(await c.req.text());
    return c.json({ ok: true }, 200);
  });
  hono.get("/api/sessions", (c) => c.json({ items: [] }));
  return { hono, writes };
}

const connFrom = (remoteAddress: string) => ({
  incoming: { socket: { remoteAddress } },
});

const post = (
  hono: Hono,
  headers: Record<string, string>,
  url = `${SERVER}/api/sessions`,
  remoteAddress?: string,
  method: "POST" | "PATCH" = "POST",
) =>
  hono.request(
    url,
    {
      method,
      // A "simple" request: no preflight, so the handler is the only gate.
      headers: { "Content-Type": "text/plain", ...headers },
      body: JSON.stringify({ id: "s" }),
    },
    remoteAddress ? connFrom(remoteAddress) : undefined,
  );

describe("origin guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["another site", "https://untrusted.example", undefined],
    ["an opaque origin", "null", undefined],
    [
      "an https origin targeting an http server on the same host without proxy proto",
      "https://play.example:3001",
      "http://play.example:3001/api/sessions",
    ],
    [
      "an http origin targeting an https server on the same host",
      "http://play.example",
      "https://play.example/api/sessions",
    ],
  ])(
    "refuses a write sent from %s before it reaches a route",
    async (_, origin, url) => {
      const { hono, writes } = app();
      const response = await post(hono, { Origin: origin }, url);
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
  ])("lets a write through with %s", async (_, headers, url) => {
    const { hono, writes } = app();
    expect((await post(hono, headers, url)).status).toBe(201);
    expect(writes).toHaveLength(1);
  });

  it.each([
    [
      "X-Forwarded-Proto: https on PATCH /api/worlds/mistport (Render custom domain)",
      {
        Origin: "https://demo.covel.cc",
        "X-Forwarded-Proto": "https",
      },
      "http://demo.covel.cc/api/worlds/mistport",
      "PATCH" as const,
      200,
    ],
    [
      "multi-hop X-Forwarded-Proto: https, http",
      {
        Origin: "https://demo.covel.cc",
        "X-Forwarded-Proto": "https, http",
      },
      "http://demo.covel.cc/api/sessions",
      "POST" as const,
      201,
    ],
    [
      "RFC 7239 Forwarded proto=https",
      {
        Origin: "https://demo.covel.cc",
        Forwarded: 'for=198.51.100.7;proto="https";host=demo.covel.cc',
      },
      "http://demo.covel.cc/api/sessions",
      "POST" as const,
      201,
    ],
    [
      "same host with explicit default :443 port normalized",
      {
        Origin: "https://demo.covel.cc",
        "X-Forwarded-Proto": "https",
      },
      "http://demo.covel.cc:443/api/sessions",
      "POST" as const,
      201,
    ],
    [
      "same host with custom TLS port",
      {
        Origin: "https://demo.covel.cc:8443",
        "X-Forwarded-Proto": "https",
      },
      "http://demo.covel.cc:8443/api/sessions",
      "POST" as const,
      201,
    ],
  ])(
    "allows same-host https origin behind a TLS-terminating proxy without TRUSTED_PROXY_IPS (%s)",
    async (_, headers, url, method, expectedStatus) => {
      const { hono, writes } = app();
      const response = await post(hono, headers, url, "10.20.30.40", method);
      expect(response.status).toBe(expectedStatus);
      expect(writes).toHaveLength(1);
    },
  );

  it.each([
    [
      "scheme downgrade (http Origin when X-Forwarded-Proto is https)",
      {
        Origin: "http://demo.covel.cc",
        "X-Forwarded-Proto": "https",
      },
      "http://demo.covel.cc/api/sessions",
    ],
    [
      "scheme downgrade (http Origin when Forwarded proto=https)",
      {
        Origin: "http://demo.covel.cc",
        Forwarded: "for=198.51.100.7;proto=https",
      },
      "http://demo.covel.cc/api/sessions",
    ],
    [
      "cross-site Origin behind TLS proxy",
      {
        Origin: "https://untrusted.example",
        "X-Forwarded-Proto": "https",
      },
      "http://demo.covel.cc/api/sessions",
    ],
    [
      "opaque Origin behind TLS proxy",
      {
        Origin: "null",
        "X-Forwarded-Proto": "https",
      },
      "http://demo.covel.cc/api/sessions",
    ],
    [
      "direct https request cannot be downgraded via X-Forwarded-Proto: http",
      {
        Origin: "http://demo.covel.cc",
        "X-Forwarded-Proto": "http",
      },
      "https://demo.covel.cc/api/sessions",
    ],
    [
      "malformed X-Forwarded-Proto does not upgrade scheme",
      {
        Origin: "https://demo.covel.cc",
        "X-Forwarded-Proto": "javascript",
      },
      "http://demo.covel.cc/api/sessions",
    ],
    [
      "port mismatch behind TLS proxy",
      {
        Origin: "https://demo.covel.cc:8443",
        "X-Forwarded-Proto": "https",
      },
      "http://demo.covel.cc/api/sessions",
    ],
  ])("refuses %s when TRUSTED_PROXY_IPS is unset", async (_, headers, url) => {
    const { hono, writes } = app();
    const response = await post(hono, headers, url, "10.20.30.40");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "origin_not_allowed",
    });
    expect(writes).toEqual([]);
  });

  it("ignores spoofed X-Forwarded-Host when peer IP is not in TRUSTED_PROXY_IPS", async () => {
    const { hono, writes } = app();
    // Without TRUSTED_PROXY_IPS set:
    const noConfig = await post(
      hono,
      {
        Origin: "https://play.example",
        "X-Forwarded-Host": "play.example",
        "X-Forwarded-Proto": "https",
      },
      undefined,
      "127.0.0.1",
    );
    expect(noConfig.status).toBe(403);
    expect(await noConfig.json()).toMatchObject({ code: "origin_not_allowed" });

    // With TRUSTED_PROXY_IPS set, but peer IP does not match:
    vi.stubEnv("TRUSTED_PROXY_IPS", "10.0.0.2");
    const untrustedPeer = await post(
      hono,
      {
        Origin: "https://play.example",
        "X-Forwarded-Host": "play.example",
        "X-Forwarded-Proto": "https",
      },
      undefined,
      "198.51.100.25",
    );
    expect(untrustedPeer.status).toBe(403);
    expect(await untrustedPeer.json()).toMatchObject({
      code: "origin_not_allowed",
    });
    expect(writes).toEqual([]);
  });

  it("honors X-Forwarded-Host and X-Forwarded-Proto from a trusted proxy and requires full scheme+host match", async () => {
    vi.stubEnv("TRUSTED_PROXY_IPS", "10.0.0.2, 127.0.0.1");
    const { hono, writes } = app();

    // Exact https + host match from trusted proxy (including IPv4-mapped IPv6 peer).
    const ok = await post(
      hono,
      {
        Origin: "https://play.example",
        "X-Forwarded-Host": "play.example",
        "X-Forwarded-Proto": "https",
      },
      undefined,
      "::ffff:10.0.0.2",
    );
    expect(ok.status).toBe(201);
    expect(writes).toHaveLength(1);

    // TLS-terminating proxy keeping original Host (only X-Forwarded-Proto set).
    const tlsOnlyOk = await post(
      hono,
      {
        Origin: "https://play.example",
        "X-Forwarded-Proto": "https",
      },
      "http://play.example/api/sessions",
      "127.0.0.1",
    );
    expect(tlsOnlyOk.status).toBe(201);
    expect(writes).toHaveLength(2);

    // Missing X-Forwarded-Proto leaves scheme as http://, refusing https:// Origin.
    const missingProto = await post(
      hono,
      {
        Origin: "https://play.example",
        "X-Forwarded-Host": "play.example",
      },
      undefined,
      "127.0.0.1",
    );
    expect(missingProto.status).toBe(403);

    // Scheme downgrade: trusted proxy says https, attacker sends http Origin.
    const schemeDowngrade = await post(
      hono,
      {
        Origin: "http://play.example",
        "X-Forwarded-Proto": "https",
      },
      "http://play.example/api/sessions",
      "127.0.0.1",
    );
    expect(schemeDowngrade.status).toBe(403);

    // Malformed X-Forwarded-Proto is rejected.
    const badProto = await post(
      hono,
      {
        Origin: "https://play.example",
        "X-Forwarded-Host": "play.example",
        "X-Forwarded-Proto": "javascript",
      },
      undefined,
      "127.0.0.1",
    );
    expect(badProto.status).toBe(403);
    expect(writes).toHaveLength(2);
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
