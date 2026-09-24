/**
 * `fetchWithRetry` redirect contract.
 *
 * The plugin-facing fetch is the implementation the runtime injects into
 * `ctx.utils` and (through the permission facade) into `ctx.media`, so its
 * redirect behaviour is a framework contract:
 * - default (no `redirect` / `"follow"` / `"error"`) fails closed on a 3xx,
 * - an explicit `redirect: "manual"` returns the raw 3xx so the caller can
 *   re-validate each `Location` itself (what media ingest does).
 *
 * Runs against a real loopback server and the real dispatcher/DNS-pinning path
 * so the assertions cover production semantics, not a stub.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWithRetry } from "../src/plugin-utils.js";

const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

let server: Server | undefined;
let baseUrl = "";

async function startServer(): Promise<void> {
  server = createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/image.png" });
      res.end();
      return;
    }
    if (req.url === "/image.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(PNG_HEADER));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP listener address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe("fetchWithRetry redirect contract", () => {
  it("fails closed on a 3xx by default (no auto-follow, no raw response)", async () => {
    await startServer();
    await expect(
      fetchWithRetry(`${baseUrl}/start`, { maxRetries: 0 }),
    ).rejects.toThrow(/refusing to follow redirect \(HTTP 302\)/);
  });

  it("fails closed on a 3xx when the caller asks for redirect:follow", async () => {
    await startServer();
    await expect(
      fetchWithRetry(`${baseUrl}/start`, {
        maxRetries: 0,
        redirect: "follow",
      }),
    ).rejects.toThrow(/refusing to follow redirect/);
  });

  it("returns the raw 3xx (status + Location) for an explicit redirect:manual", async () => {
    await startServer();
    const response = await fetchWithRetry(`${baseUrl}/start`, {
      maxRetries: 0,
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/image.png");
  });

  it("lets the caller validate and fetch the redirect target itself", async () => {
    await startServer();
    const first = await fetchWithRetry(`${baseUrl}/start`, {
      maxRetries: 0,
      redirect: "manual",
    });
    const location = first.headers.get("location");
    expect(location).toBeTruthy();
    await first.arrayBuffer();

    const next = new URL(location as string, new URL(`${baseUrl}/start`));
    const second = await fetchWithRetry(next, {
      maxRetries: 0,
      redirect: "manual",
    });
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(PNG_HEADER);
  });
});
