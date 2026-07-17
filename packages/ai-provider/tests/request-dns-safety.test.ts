/**
 * S-05: the core provider HTTP path (postJson / getJson) must route through
 * the DNS-pinning dispatcher, so a hostname that passes the string-level
 * `validateBaseUrl` check but resolves to a private / loopback address is
 * rejected at connect time (closing the SSRF / DNS-rebinding gap that
 * previously only the plugin `ctx.http` helper covered).
 *
 * DNS is mocked; a private answer must fail before any socket I/O. The
 * loopback happy path runs against a real local HTTP server to prove the
 * dispatcher wiring still serves legitimate Ollama-style local endpoints.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, postJson } from "../src/adapters/http.js";
import { createPinnedDispatcher } from "../src/adapters/http/dns-safety.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const lookupMock = vi.mocked(lookup);

afterEach(() => {
  lookupMock.mockReset();
  vi.unstubAllEnvs();
});

describe("core request DNS SSRF safety (S-05)", () => {
  // Hosted tiers keep the strict public-only policy on the core provider path.
  it("rejects a POST to a hostname resolving to a private IP (hosted tier)", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    lookupMock.mockResolvedValue([{ address: "10.0.0.8", family: 4 }] as never);

    await expect(
      postJson(
        { baseUrl: "https://internal.example", apiKey: "sk-secret" },
        "/chat/completions",
        {},
      ),
    ).rejects.toThrow(/SSRF policy rejected internal\.example/);
  });

  it("rejects a GET to a hostname resolving to cloud metadata (hosted tier)", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "commercial");
    lookupMock.mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never);

    await expect(
      getJson({ baseUrl: "https://rebind.example" }, "/models"),
    ).rejects.toThrow(/disallowed address 169\.254\.169\.254/);
  });

  it("rejects localhost when it does not actually resolve to loopback (hosted tier)", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    lookupMock.mockResolvedValue([
      { address: "192.168.1.50", family: 4 },
    ] as never);

    await expect(
      postJson({ baseUrl: "http://localhost:11434" }, "/chat/completions", {}),
    ).rejects.toThrow(/disallowed address 192\.168\.1\.50/);
  });

  it("self tier accepts private resolver answers on the trusted provider path", async () => {
    // self tier (default) = single-user local play: a TUN proxy fake-IP
    // (198.18/15) and a LAN Ollama (192.168.x.x) both resolve to private
    // ranges and must not be rejected on the user's own configured baseUrl,
    // or provider calls fail on those machines. Socket stays pinned regardless.
    for (const address of ["198.18.2.176", "192.168.1.50"]) {
      lookupMock.mockResolvedValue([{ address, family: 4 }] as never);
      const dispatcher = await createPinnedDispatcher(
        new URL("https://api.deepseek.com"),
        true, // trustedProviderPath — core provider request
      );
      expect(dispatcher).toBeDefined();
      await dispatcher.close();
    }
  });

  it("self tier still rejects private answers on the ctx.http (plugin) path", async () => {
    // Third-party plugin code never gets the self-tier exemption, so it can
    // not probe the local network even on a desktop install.
    lookupMock.mockResolvedValue([
      { address: "198.18.2.176", family: 4 },
    ] as never);

    await expect(
      createPinnedDispatcher(new URL("https://api.deepseek.com")),
    ).rejects.toThrow(/disallowed address 198\.18\.2\.176/);
  });

  it("rejects private answers on the trusted path on hosted tiers", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    lookupMock.mockResolvedValue([
      { address: "198.18.2.176", family: 4 },
    ] as never);

    await expect(
      createPinnedDispatcher(new URL("https://api.deepseek.com"), true),
    ).rejects.toThrow(/disallowed address 198\.18\.2\.176/);
  });

  it("rejects a literal private-range URL even on the self trusted path", async () => {
    // IP-literal URLs never get the self-tier exemption (url-safety's string
    // check also blocks these upstream).
    await expect(
      createPinnedDispatcher(new URL("https://198.18.1.1"), true),
    ).rejects.toThrow(/disallowed address 198\.18\.1\.1/);
  });

  it("still serves loopback (local Ollama-style) endpoints", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );
    const { port } = server.address() as AddressInfo;

    try {
      const response = await postJson(
        { baseUrl: `http://127.0.0.1:${port}` },
        "/chat/completions",
        {},
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  });
});
