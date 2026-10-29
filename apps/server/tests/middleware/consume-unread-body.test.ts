import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createConsumeUnreadBodyMiddleware } from "../../src/middleware/consume-unread-body.js";
import { createRequestBodyLimitMiddleware } from "../../src/middleware/request-body-limit.js";

let server: ServerType | undefined;

afterEach(async () => {
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

function appUnderTest(): Hono {
  const app = new Hono();
  app.use("*", createConsumeUnreadBodyMiddleware());
  // As in the app: the body limit starts reading the body stream, after which
  // @hono/node-server's own drain stalls.
  app.use("*", createRequestBodyLimitMiddleware());
  // A shared world refuses a writer without the operator token, unread.
  app.patch("/reject", (c) => c.json({ error: "Operator required" }, 401));
  app.post("/echo", async (c) => c.json({ size: (await c.req.text()).length }));
  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        await stream.sleep(100);
        await stream.write(": ping\n\n");
      }
    }),
  );
  return app;
}

/**
 * Send a large body that the route rejects, then open an SSE stream on the
 * same keep-alive socket, as a browser does.
 */
async function streamAfterRejectedBody(
  port: number,
  path: string,
  method: string,
): Promise<{ pings: number; closed: boolean; firstStatus: string }> {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const body = "x".repeat(200_000);
  let received = "";
  let closed = false;
  socket.on("data", (chunk) => {
    received += chunk.toString("latin1");
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.write(
    `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`,
  );
  await expect
    .poll(() => /\r\n\r\n/.test(received), { timeout: 5_000 })
    .toBe(true);
  const firstStatus = received.split("\r\n")[0] ?? "";
  // Let the first response finish before reusing the connection.
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.write(
    "GET /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n",
  );
  // Past @hono/node-server's 500 ms drain timeout.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const pings = received.split(": ping").length - 1;
  socket.destroy();
  return { pings, closed, firstStatus };
}

describe("consume unread request bodies", () => {
  it("keeps the connection alive for the next request after an early rejection", async () => {
    const port = await start(appUnderTest());

    const result = await streamAfterRejectedBody(port, "/reject", "PATCH");

    expect(result.firstStatus).toBe("HTTP/1.1 401 Unauthorized");
    expect(result.closed).toBe(false);
    expect(result.pings).toBeGreaterThanOrEqual(8);
  });

  it("leaves a body the route read alone", async () => {
    const port = await start(appUnderTest());

    const result = await streamAfterRejectedBody(port, "/echo", "POST");

    expect(result.firstStatus).toBe("HTTP/1.1 200 OK");
    expect(result.closed).toBe(false);
    expect(result.pings).toBeGreaterThanOrEqual(8);
  });

  it.each([
    ["reads a rejected body within the limit", 500, true],
    ["does not read a body larger than any route accepts", 5_000, false],
  ])("%s", async (_name, size, expected) => {
    const app = new Hono();
    let read: boolean | undefined;
    // Outside the middleware under test: sees the request after it ran.
    app.use("*", async (c, next) => {
      await next();
      read = c.req.raw.bodyUsed;
    });
    app.use("*", createConsumeUnreadBodyMiddleware(1_000));
    app.patch("/reject", (c) => c.json({ error: "no" }, 401));

    const response = await app.request("/reject", {
      method: "PATCH",
      headers: {
        "content-length": String(size),
        "content-type": "text/plain",
      },
      body: "x".repeat(size),
    });

    expect(response.status).toBe(401);
    expect(read).toBe(expected);
  });
});
