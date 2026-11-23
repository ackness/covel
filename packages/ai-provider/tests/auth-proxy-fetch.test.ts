import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureOutboundProxy,
  OUTBOUND_TEST_FETCH_HOOK,
  resetOutboundProxyForTests,
} from "../src/outbound-network.js";
import {
  fetchWithAuthProxyRetry,
  fetchWithRetry,
} from "../src/plugin-utils.js";

describe("fetchWithRetry and fetchWithAuthProxyRetry (net.authProxy)", () => {
  afterEach(async () => {
    Reflect.set(globalThis, OUTBOUND_TEST_FETCH_HOOK, true);
    await resetOutboundProxyForTests();
  });

  it("refuses proxy: instance-auth on direct fetchWithRetry", async () => {
    await expect(
      fetchWithRetry("https://provider.example/oauth/token", {
        method: "POST",
        proxy: "instance-auth",
      }),
    ).rejects.toThrow(
      /net\.authProxy is not permitted on direct fetchWithRetry/,
    );
  });

  it("routes fetchWithAuthProxyRetry through configured HTTP CONNECT proxy without local DNS pinning", async () => {
    let proxyConnectCount = 0;
    const target = http.createServer((req, res) => {
      if (req.url === "/token" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "proxied-token" }));
        return;
      }
      if (req.url === "/redir") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest" });
        res.end("redirecting");
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const targetPort = (target.address() as AddressInfo).port;

    const proxy = http.createServer((_req, res) => {
      res.writeHead(405).end();
    });
    proxy.on("connect", (_req, clientSocket, head) => {
      proxyConnectCount += 1;
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => {
        clientSocket.destroy();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as AddressInfo).port;

    try {
      Reflect.set(globalThis, OUTBOUND_TEST_FETCH_HOOK, false);
      configureOutboundProxy({
        mode: "http",
        url: `http://127.0.0.1:${proxyPort}`,
      });

      const res = await fetchWithAuthProxyRetry(
        `http://127.0.0.1:${targetPort}/token`,
        {
          method: "POST",
          maxRetries: 0,
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ access_token: "proxied-token" });
      expect(proxyConnectCount).toBe(1);

      // Unconditionally rejects 3xx redirects even if redirect: "manual" is supplied.
      await expect(
        fetchWithAuthProxyRetry(`http://127.0.0.1:${targetPort}/redir`, {
          redirect: "manual",
          maxRetries: 0,
        }),
      ).rejects.toThrow(/refusing to follow redirect \(HTTP 302\)/);
    } finally {
      Reflect.set(globalThis, OUTBOUND_TEST_FETCH_HOOK, true);
      await resetOutboundProxyForTests();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("still enforces SSRF URL checks for private/metadata addresses on fetchWithAuthProxyRetry", async () => {
    await expect(
      fetchWithAuthProxyRetry("http://169.254.169.254/latest/meta-data", {
        maxRetries: 0,
      }),
    ).rejects.toThrow(/SSRF policy/i);

    await expect(
      fetchWithAuthProxyRetry("https://10.0.0.1/internal", {
        maxRetries: 0,
      }),
    ).rejects.toThrow(/SSRF policy/i);
  });
});
