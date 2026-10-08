// @vitest-environment node

import {
  createServer as createHttpServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeProxyConfig } from "../../vite.config.js";

let upstream: Server | undefined;
let vite: ViteDevServer | undefined;
let viteRoot: string | undefined;
let requestController: AbortController | undefined;

function portOf(server: Pick<Server, "address">): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server has no TCP port");
  }
  return address.port;
}

async function startUpstream(handler: RequestListener) {
  upstream = createHttpServer(handler);
  await new Promise<void>((resolve) =>
    upstream!.listen(0, "127.0.0.1", resolve),
  );
  return portOf(upstream);
}

async function startProxy(upstreamPort: number): Promise<string> {
  // Vite scans its root for entry files and close() waits for that scan. The
  // temp directory itself can hold thousands of directories from other tests,
  // so the server gets an empty directory of its own.
  viteRoot = await mkdtemp(path.join(tmpdir(), "covel-vite-proxy-"));
  vite = await createViteServer({
    configFile: false,
    root: viteRoot,
    appType: "custom",
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: createRuntimeProxyConfig({ RUNTIME_PORT: String(upstreamPort) }),
      watch: null,
    },
  });
  await vite.listen();
  if (!vite.httpServer) throw new Error("Vite HTTP server was not started");
  return `http://127.0.0.1:${portOf(vite.httpServer)}`;
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("HTTP stream did not settle")),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(async () => {
  requestController?.abort();
  requestController = undefined;
  upstream?.closeAllConnections();
  if (vite) await vite.close();
  if (upstream)
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  if (viteRoot) await rm(viteRoot, { recursive: true, force: true });
  vite = undefined;
  viteRoot = undefined;
  upstream = undefined;
});

describe("Vite runtime proxy", () => {
  it("settles an SSE reader when the upstream disconnects mid-response", async () => {
    let upstreamResponse: ServerResponse | undefined;
    const upstreamPort = await startUpstream((_req, res) => {
      upstreamResponse = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"type":"started"}\n\n');
    });
    const proxyUrl = await startProxy(upstreamPort);
    requestController = new AbortController();

    const response = await within(
      fetch(`${proxyUrl}/api/executions/1/events`, {
        signal: requestController.signal,
      }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await within(reader.read());
    expect(new TextDecoder().decode(first.value)).toContain('"type":"started"');
    if (!upstreamResponse) throw new Error("Upstream response was not created");
    upstreamResponse.destroy();

    const outcome = await within(
      reader.read().then(
        ({ done }) => (done ? "closed" : "data"),
        () => "error",
      ),
    );
    expect(["closed", "error"]).toContain(outcome);
  });

  it("preserves a normal SSE response and EOF", async () => {
    const upstreamPort = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"type":"done"}\n\n');
    });
    const proxyUrl = await startProxy(upstreamPort);
    requestController = new AbortController();

    const response = await within(
      fetch(`${proxyUrl}/api/executions/1/events`, {
        signal: requestController.signal,
      }),
    );
    expect(response.status).toBe(200);
    expect(await within(response.text())).toBe('data: {"type":"done"}\n\n');
  });

  it("returns 503 when the runtime server has not started", async () => {
    const unusedPort = await startUpstream((_req, res) => res.end());
    const proxyUrl = await startProxy(unusedPort);
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;

    const response = await within(fetch(`${proxyUrl}/api/worlds`));
    expect(response.status).toBe(503);
    expect(await within(response.json())).toEqual({
      error: "runtime server not ready",
    });
  });
});
