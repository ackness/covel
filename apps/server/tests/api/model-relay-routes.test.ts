// @vitest-environment node
/**
 * The local model relay over HTTP: the browser's stream receives a model
 * request, and its posts become the body the server reads.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readRuntimeEnv } from "@covel/shared";
import {
  hostProfileMiddleware,
  resolveHostProfile,
} from "../../src/host-profile.js";
import { createModelRelayRoutes } from "../../src/routes/api/model-relay.js";
import { createModelRelayRegistry } from "../../src/model-relay/registry.js";

const CHANNEL = "relay-channel-for-tests-0123456789abcdef";

function appFor(
  vars: Record<string, string>,
  storeBackend: "memory" | "sqlite",
) {
  const registry = createModelRelayRegistry();
  const app = new Hono();
  app.use(
    "*",
    hostProfileMiddleware(
      resolveHostProfile(readRuntimeEnv(vars), { storeBackend }),
    ),
  );
  app.route("/api/model-relay", createModelRelayRoutes(registry));
  return { app, registry };
}

async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  name: string,
  buffer: { text: string },
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  for (;;) {
    const match = new RegExp(`event: ${name}\\ndata: (.*)\\n`).exec(
      buffer.text,
    );
    if (match) {
      buffer.text = buffer.text.slice(match.index + match[0].length);
      return JSON.parse(match[1]!) as Record<string, unknown>;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${name}`);
    buffer.text += decoder.decode(value, { stream: true });
  }
}

describe("model relay routes", () => {
  it("relays a request through the browser's stream and posts", async () => {
    const { app, registry } = appFor({ NODE_ENV: "production" }, "memory");
    const stream = await app.request("/api/model-relay/stream", {
      headers: { "X-Model-Relay": CHANNEL },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const buffer = { text: "" };
    await nextEvent(reader, "ready", buffer);

    const answer = registry.relayFor(CHANNEL).fetch({
      url: "http://127.0.0.1:3425/v1/models",
      method: "GET",
      headers: {},
    });
    const request = await nextEvent(reader, "request", buffer);
    expect(request).toMatchObject({
      type: "request",
      url: "http://127.0.0.1:3425/v1/models",
      method: "GET",
    });
    const id = String(request.id);
    const post = (path: string, init: RequestInit = {}) =>
      app.request(`/api/model-relay/requests/${id}/${path}`, {
        method: "POST",
        ...init,
        headers: { "X-Model-Relay": CHANNEL, ...init.headers },
      });

    expect(
      (
        await post("head", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post("chunk", {
          headers: { "content-type": "application/octet-stream" },
          body: new TextEncoder().encode('{"data":[]}'),
        })
      ).status,
    ).toBe(204);
    expect((await post("end")).status).toBe(204);
    const response = await answer;
    expect(await response.json()).toEqual({ data: [] });

    // A post for a request this channel does not own is refused.
    const stranger = await app.request(`/api/model-relay/requests/${id}/end`, {
      method: "POST",
      headers: { "X-Model-Relay": "x".repeat(40) },
    });
    expect(stranger.status).toBe(404);
    await reader.cancel();
  });

  it("refuses a malformed head and keeps the failure message to one line", async () => {
    const { app, registry } = appFor({ NODE_ENV: "production" }, "memory");
    const stream = await app.request("/api/model-relay/stream", {
      headers: { "X-Model-Relay": CHANNEL },
    });
    const reader = stream.body!.getReader();
    const buffer = { text: "" };
    await nextEvent(reader, "ready", buffer);
    const answer = registry.relayFor(CHANNEL).fetch({
      url: "http://127.0.0.1:3425/v1/models",
      method: "GET",
      headers: {},
    });
    const id = String((await nextEvent(reader, "request", buffer)).id);
    const post = (path: string, body: unknown) =>
      app.request(`/api/model-relay/requests/${id}/${path}`, {
        method: "POST",
        headers: {
          "X-Model-Relay": CHANNEL,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect(
      (await post("head", { status: 200, headers: { "x\nevil": "1" } })).status,
    ).toBe(400);
    expect(
      (await post("fail", { message: "line one\n[server] forged line" }))
        .status,
    ).toBe(204);
    await expect(answer).rejects.toThrow(
      "Local model relay: line one [server] forged line",
    );
    await reader.cancel();
  });

  it("needs the channel header", async () => {
    const { app } = appFor({ NODE_ENV: "production" }, "memory");
    const response = await app.request("/api/model-relay/stream");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "model_relay_channel_required",
    });
  });

  it("is not offered on a personal host, which reaches local models itself", async () => {
    const { app } = appFor({}, "sqlite");
    const response = await app.request("/api/model-relay/stream", {
      headers: { "X-Model-Relay": CHANNEL },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "model_relay_unavailable",
    });
  });

  it("serializes ready, request, and heartbeat writes so frames never interleave", async () => {
    const { SSEStreamingApi } = await import("hono/streaming");
    const { vi } = await import("vitest");
    vi.useFakeTimers();

    const originalWrite = SSEStreamingApi.prototype.write;
    let inFlight = 0;
    let maxConcurrent = 0;
    const gates: Array<{
      chunk: string;
      release: PromiseWithResolvers<void>;
    }> = [];

    const writeSpy = vi
      .spyOn(SSEStreamingApi.prototype, "write")
      .mockImplementation(async function (
        this: InstanceType<typeof SSEStreamingApi>,
        input,
      ) {
        const text =
          typeof input === "string" ? input : new TextDecoder().decode(input);
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        const gate = {
          chunk: text,
          release: Promise.withResolvers<void>(),
        };
        gates.push(gate);
        try {
          await gate.release.promise;
          return await originalWrite.call(this, input);
        } finally {
          inFlight -= 1;
        }
      });

    try {
      const { app, registry } = appFor({ NODE_ENV: "production" }, "memory");
      // Queue a fetch BEFORE attaching the stream so attach() wakes it
      // immediately while the initial `ready` frame is still writing.
      const pendingFetch = registry.relayFor(CHANNEL).fetch({
        url: "http://127.0.0.1:3425/v1/models",
        method: "GET",
        headers: {},
      });
      void pendingFetch.catch(() => {});

      const stream = await app.request("/api/model-relay/stream", {
        headers: { "X-Model-Relay": CHANNEL },
      });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      const received: string[] = [];
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received.push(decoder.decode(value, { stream: true }));
        }
      })();

      // Wait for the initial `ready` write to start, and flush microtasks so
      // the woken relay request tries to write while `ready` is still in flight.
      await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1));
      await Promise.resolve();
      await Promise.resolve();
      expect(maxConcurrent).toBe(1);
      expect(gates).toHaveLength(1);
      expect(gates[0]!.chunk).toContain("event: ready");

      // Release `ready`; now the queued `request` frame writes next.
      gates[0]!.release.resolve();
      await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(2));
      expect(gates[1]!.chunk).toContain("event: request");
      expect(maxConcurrent).toBe(1);

      // While `request` write is held mid-flight, trigger the heartbeat timer!
      // Heartbeat `: ping\n\n` must queue behind `request`, never interleave.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(maxConcurrent).toBe(1);
      expect(gates).toHaveLength(2);

      // Release `request`; heartbeat `: ping\n\n` starts only afterward.
      gates[1]!.release.resolve();
      await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(3));
      expect(gates[2]!.chunk).toBe(": ping\n\n");
      expect(maxConcurrent).toBe(1);

      gates[2]!.release.resolve();
      await vi.waitFor(() => expect(received.join("")).toContain(": ping\n\n"));
      const fullText = received.join("");
      expect(fullText.indexOf("event: ready")).toBeLessThan(
        fullText.indexOf("event: request"),
      );
      expect(fullText.indexOf("event: request")).toBeLessThan(
        fullText.indexOf(": ping\n\n"),
      );

      await reader.cancel();
      await pump;
    } finally {
      for (const gate of gates) gate.release.resolve();
      writeSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("exits the SSE heartbeat loop immediately when shutdown aborts requestWork", async () => {
    const { createApplicationWork } = await import(
      "../../src/application-work.js"
    );
    const registry = createModelRelayRegistry();
    const work = createApplicationWork();
    const app = new Hono();
    app.use(
      "*",
      hostProfileMiddleware(
        resolveHostProfile(readRuntimeEnv({ NODE_ENV: "production" }), {
          storeBackend: "memory",
        }),
      ),
    );
    app.use("*", work.middleware);
    app.route("/api/model-relay", createModelRelayRoutes(registry));

    const stream = await app.request("/api/model-relay/stream", {
      headers: { "X-Model-Relay": CHANNEL },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await nextEvent(reader, "ready", { text: "" });

    // Drain should complete promptly (well under the 15s HEARTBEAT_MS) once
    // abort/close interrupts waitHeartbeat.
    const started = Date.now();
    await work.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    await reader.cancel().catch(() => {});
  });
});
