import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson } from "../src/adapters/http.js";
import {
  configureOutboundProxy,
  normalizeOutboundProxyConfig,
  outboundFetch,
  parseSystemProxyRoutes,
  resetOutboundProxyForTests,
} from "../src/outbound-network.js";

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await resetOutboundProxyForTests();
});

describe("outbound network transport", () => {
  it("pairs an npm Undici dispatcher with npm Undici fetch", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const incompatibleGlobalFetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed", {
        cause: new Error("invalid onRequestStart method"),
      }),
    );
    vi.stubGlobal("fetch", incompatibleGlobalFetch);

    const target = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const { port } = target.address() as AddressInfo;

    try {
      const response = await getJson(
        { baseUrl: `http://127.0.0.1:${port}` },
        "/models",
      );
      expect(response.status).toBe(200);
      expect(incompatibleGlobalFetch).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("normalizes the compact HTTP and SOCKS5 settings", () => {
    expect(
      normalizeOutboundProxyConfig({ mode: "http", url: "127.0.0.1:7890" }),
    ).toEqual({ mode: "http", url: "http://127.0.0.1:7890" });
    expect(
      normalizeOutboundProxyConfig({ mode: "socks", url: "127.0.0.1:7891" }),
    ).toEqual({ mode: "socks", url: "socks5://127.0.0.1:7891" });
    expect(
      normalizeOutboundProxyConfig({
        mode: "socks",
        url: "socks://127.0.0.1:7891",
      }),
    ).toEqual({ mode: "socks", url: "socks5://127.0.0.1:7891" });
    expect(() =>
      normalizeOutboundProxyConfig({
        mode: "http",
        url: "socks5://127.0.0.1:7891",
      }),
    ).toThrow(/HTTP/i);
  });

  it("preserves supported Chromium proxy routes in fallback order", () => {
    expect(
      parseSystemProxyRoutes(
        "PROXY proxy-1.example:8080; HTTPS proxy-2.example:8443; SOCKS5 [::1]:1080; DIRECT",
      ),
    ).toEqual([
      { kind: "proxy", url: "http://proxy-1.example:8080" },
      { kind: "proxy", url: "https://proxy-2.example:8443" },
      { kind: "proxy", url: "socks5://[::1]:1080" },
      { kind: "direct" },
    ]);
    expect(parseSystemProxyRoutes("SOCKS4 proxy.example:1080; DIRECT")).toEqual(
      [{ kind: "direct" }],
    );
    expect(() =>
      parseSystemProxyRoutes(
        "SOCKS4 proxy.example:1080; QUIC proxy.example:443",
      ),
    ).toThrow(/supported route/i);
  });

  it("resolves system proxy rules for every concrete target URL", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const resolveSystemProxy = vi.fn(async (targetUrl: string) =>
      targetUrl.includes("provider.example")
        ? "PROXY proxy.example:8080"
        : "DIRECT",
    );

    const status = configureOutboundProxy({
      mode: "system",
      resolveSystemProxy,
    });
    expect(status).toMatchObject({
      mode: "system",
      effective: "system",
      systemAvailable: true,
    });

    await outboundFetch("https://provider.example/v1/models");
    await outboundFetch("http://127.0.0.1:3001/api/health");

    expect(resolveSystemProxy).toHaveBeenNthCalledWith(
      1,
      "https://provider.example/v1/models",
      undefined,
    );
    expect(resolveSystemProxy).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3001/api/health",
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.dispatcher).not.toBe(
      fetchMock.mock.calls[1]?.[1]?.dispatcher,
    );
  });

  it("falls back through system routes only after connection failures", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const connectionFailure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED proxy"), {
        code: "ECONNREFUSED",
      }),
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionFailure)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    configureOutboundProxy({
      mode: "system",
      resolveSystemProxy: async () =>
        "PROXY dead-proxy.example:8080; PROXY live-proxy.example:8080; DIRECT",
    });

    await expect(
      outboundFetch("https://provider.example/v1/models"),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response("upstream failed", { status: 500 }),
    );
    const response = await outboundFetch("https://provider.example/v1/models");
    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back after a SOCKS5 destination connection failure", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const socksFailure = new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("SOCKS5 connection failed: Connection refused"),
        { code: "UND_ERR_SOCKS5_REPLY_5" },
      ),
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(socksFailure)
      .mockResolvedValueOnce(new Response("direct", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    configureOutboundProxy({
      mode: "system",
      resolveSystemProxy: async () => "SOCKS5 dead-proxy.example:1080; DIRECT",
    });

    await expect(
      outboundFetch("https://provider.example/v1/models"),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("routes core provider requests through an HTTP proxy", async () => {
    vi.stubEnv("NODE_ENV", "production");
    let proxyConnections = 0;
    const target = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"proxied":true}');
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const targetPort = (target.address() as AddressInfo).port;

    const proxy = createServer();
    proxy.on("connect", (req, clientSocket, head) => {
      proxyConnections += 1;
      const [hostname, rawPort] = (req.url ?? "").split(":");
      const upstream = connect(Number(rawPort), hostname);
      upstream.once("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as AddressInfo).port;

    try {
      configureOutboundProxy({
        mode: "http",
        url: `http://127.0.0.1:${proxyPort}`,
      });
      const response = await getJson(
        { baseUrl: `http://127.0.0.1:${targetPort}` },
        "/models",
      );
      expect(await response.json()).toEqual({ proxied: true });

      // Dynamic system routes construct and cache their own dispatcher. Keep
      // this real CONNECT check beside the explicit-proxy path so an Undici
      // default change cannot silently split their transport semantics.
      await resetOutboundProxyForTests();
      configureOutboundProxy({
        mode: "system",
        resolveSystemProxy: async () => `PROXY 127.0.0.1:${proxyPort}`,
      });
      const systemResponse = await getJson(
        { baseUrl: `http://127.0.0.1:${targetPort}` },
        "/models",
      );
      expect(await systemResponse.json()).toEqual({ proxied: true });
      expect(proxyConnections).toBe(2);
    } finally {
      await resetOutboundProxyForTests();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("surfaces the nested transport cause", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
            code: "ECONNREFUSED",
          }),
        }),
      ),
    );

    await expect(
      getJson({ baseUrl: "https://provider.example" }, "/models"),
    ).rejects.toThrow(/ECONNREFUSED.*connect ECONNREFUSED/);
  });
});
