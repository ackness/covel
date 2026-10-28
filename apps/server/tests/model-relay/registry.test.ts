// @vitest-environment node
/**
 * The local model relay registry: a model call made for a browser's channel
 * travels to that browser and comes back as a streaming Response.
 */

import { describe, expect, it } from "vitest";
import {
  createModelRelayRegistry,
  parseModelRelayChannel,
  type ModelRelayEvent,
} from "../../src/model-relay/registry.js";

const CHANNEL = "c".repeat(40);
const OTHER = "o".repeat(40);
const encoder = new TextEncoder();

function attachRecorder(
  registry: ReturnType<typeof createModelRelayRegistry>,
  channel = CHANNEL,
) {
  const events: ModelRelayEvent[] = [];
  const detach = registry.attach(channel, (event) => events.push(event));
  if (!detach) throw new Error("channel refused");
  return { events, detach };
}

const lastRequestId = (events: readonly ModelRelayEvent[]) => {
  const request = [...events].reverse().find((e) => e.type === "request");
  if (!request) throw new Error("no request event");
  return request.id;
};

describe("parseModelRelayChannel", () => {
  it("accepts only long URL-safe IDs", () => {
    expect(parseModelRelayChannel(` ${CHANNEL} `)).toBe(CHANNEL);
    expect(parseModelRelayChannel("short")).toBeUndefined();
    expect(parseModelRelayChannel(`${"a".repeat(40)}/..`)).toBeUndefined();
    expect(parseModelRelayChannel(undefined)).toBeUndefined();
  });
});

describe("model relay registry", () => {
  it("sends the request to the channel and streams the browser's answer back", async () => {
    const registry = createModelRelayRegistry();
    const { events } = attachRecorder(registry);
    const answer = registry.relayFor(CHANNEL).fetch({
      url: "http://127.0.0.1:3425/v1/chat/completions",
      method: "POST",
      headers: { authorization: "Bearer sk-local" },
      body: '{"stream":true}',
    });
    await Promise.resolve();
    expect(events).toEqual([
      {
        type: "request",
        id: expect.any(String),
        url: "http://127.0.0.1:3425/v1/chat/completions",
        method: "POST",
        headers: { authorization: "Bearer sk-local" },
        body: '{"stream":true}',
      },
    ]);
    const id = lastRequestId(events);
    expect(
      registry.head(CHANNEL, id, {
        status: 200,
        headers: { "content-type": "text/event-stream", "set-cookie": "x" },
      }),
    ).toBe("ok");
    const response = await answer;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(registry.chunk(CHANNEL, id, encoder.encode("data: a\n\n"))).toBe(
      "ok",
    );
    expect(registry.chunk(CHANNEL, id, encoder.encode("data: b\n\n"))).toBe(
      "ok",
    );
    expect(registry.end(CHANNEL, id)).toBe("ok");
    expect(await response.text()).toBe("data: a\n\ndata: b\n\n");
    expect(registry.pendingCount).toBe(0);
  });

  it("keeps each channel's requests to that channel", async () => {
    const registry = createModelRelayRegistry();
    const { events } = attachRecorder(registry);
    attachRecorder(registry, OTHER);
    const answer = registry
      .relayFor(CHANNEL)
      .fetch({ url: "http://localhost:1/", method: "GET", headers: {} });
    await Promise.resolve();
    const id = lastRequestId(events);
    expect(registry.head(OTHER, id, { status: 200, headers: {} })).toBe(
      "unknown",
    );
    expect(registry.fail(OTHER, id, "nope")).toBe("unknown");
    registry.fail(CHANNEL, id, "could not reach the model server");
    await expect(answer).rejects.toThrow(
      "Local model relay: could not reach the model server",
    );
  });

  it("reports a failure in the middle of the body to its reader", async () => {
    const registry = createModelRelayRegistry();
    const { events } = attachRecorder(registry);
    const answer = registry
      .relayFor(CHANNEL)
      .fetch({ url: "http://localhost:1/", method: "GET", headers: {} });
    await Promise.resolve();
    const id = lastRequestId(events);
    registry.head(CHANNEL, id, { status: 200, headers: {} });
    const response = await answer;
    registry.chunk(CHANNEL, id, encoder.encode("partial"));
    registry.fail(CHANNEL, id, "the connection dropped");
    await expect(response.text()).rejects.toThrow("the connection dropped");
  });

  it("cancels the browser's request when the caller aborts", async () => {
    const registry = createModelRelayRegistry();
    const { events } = attachRecorder(registry);
    const controller = new AbortController();
    const answer = registry.relayFor(CHANNEL).fetch({
      url: "http://localhost:1/",
      method: "GET",
      headers: {},
      signal: controller.signal,
    });
    await Promise.resolve();
    const id = lastRequestId(events);
    controller.abort();
    await expect(answer).rejects.toThrow();
    expect(events.at(-1)).toEqual({ type: "cancel", id });
    expect(registry.head(CHANNEL, id, { status: 200, headers: {} })).toBe(
      "unknown",
    );
  });

  it("fails what was in flight when the browser disconnects or reconnects", async () => {
    const registry = createModelRelayRegistry();
    const first = attachRecorder(registry);
    const lost = registry
      .relayFor(CHANNEL)
      .fetch({ url: "http://localhost:1/", method: "GET", headers: {} });
    await Promise.resolve();
    attachRecorder(registry); // the same channel reconnects
    await expect(lost).rejects.toThrow("the browser reconnected");
    // The old stream's detach no longer touches the new connection.
    first.detach();
    const second = attachRecorder(registry);
    const later = registry
      .relayFor(CHANNEL)
      .fetch({ url: "http://localhost:1/", method: "GET", headers: {} });
    await Promise.resolve();
    second.detach();
    await expect(later).rejects.toThrow("the browser disconnected");
  });

  it("waits briefly for a channel that is still connecting", async () => {
    const registry = createModelRelayRegistry({ connectWaitMs: 50 });
    await expect(
      registry
        .relayFor(CHANNEL)
        .fetch({ url: "http://localhost:1/", method: "GET", headers: {} }),
    ).rejects.toThrow("your browser is not connected");

    const answer = registry
      .relayFor(CHANNEL)
      .fetch({ url: "http://localhost:1/", method: "GET", headers: {} });
    const { events } = attachRecorder(registry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    registry.head(CHANNEL, lastRequestId(events), {
      status: 204,
      headers: {},
    });
    expect((await answer).status).toBe(204);
  });

  it("fails the request, rather than leaving it waiting, when the head is invalid", async () => {
    const registry = createModelRelayRegistry();
    const { events } = attachRecorder(registry);
    const answer = registry
      .relayFor(CHANNEL)
      .fetch({ url: "http://localhost:1/", method: "GET", headers: {} });
    await Promise.resolve();
    const id = lastRequestId(events);
    expect(
      registry.head(CHANNEL, id, {
        status: 200,
        headers: { "bad header": "x" },
      }),
    ).toBe("invalid");
    await expect(answer).rejects.toThrow("invalid answer");
    expect(events.at(-1)).toEqual({ type: "cancel", id });
    expect(registry.pendingCount).toBe(0);
  });

  it("ends the older stream when a channel is attached again", () => {
    const registry = createModelRelayRegistry();
    const closed: string[] = [];
    registry.attach(
      CHANNEL,
      () => {},
      () => closed.push("first"),
    );
    registry.attach(
      CHANNEL,
      () => {},
      () => closed.push("second"),
    );
    expect(closed).toEqual(["first"]);
  });

  it("leaves nothing behind when the caller aborts while the channel connects", async () => {
    const registry = createModelRelayRegistry({ connectWaitMs: 1_000 });
    const controller = new AbortController();
    const answer = registry.relayFor(CHANNEL).fetch({
      url: "http://localhost:1/",
      method: "GET",
      headers: {},
      signal: controller.signal,
    });
    controller.abort();
    attachRecorder(registry);
    await expect(answer).rejects.toThrow();
    expect(registry.pendingCount).toBe(0);
  });

  it("refuses a new channel beyond its limit but accepts a reconnect", () => {
    const registry = createModelRelayRegistry({ maxChannels: 1 });
    attachRecorder(registry);
    expect(registry.canAttach(OTHER)).toBe(false);
    expect(registry.attach(OTHER, () => {})).toBeUndefined();
    expect(registry.canAttach(CHANNEL)).toBe(true);
    expect(registry.attach(CHANNEL, () => {})).toBeTypeOf("function");
  });

  it("enforces its limits", async () => {
    const registry = createModelRelayRegistry({
      maxPendingPerChannel: 1,
      maxRequestBodyBytes: 8,
      maxResponseBytes: 4,
    });
    const { events } = attachRecorder(registry);
    const relay = registry.relayFor(CHANNEL);
    await expect(
      relay.fetch({
        url: "http://localhost:1/",
        method: "POST",
        headers: {},
        body: "123456789",
      }),
    ).rejects.toThrow("too large to relay");
    const answer = relay.fetch({
      url: "http://localhost:1/",
      method: "GET",
      headers: {},
    });
    await Promise.resolve();
    await expect(
      relay.fetch({ url: "http://localhost:1/", method: "GET", headers: {} }),
    ).rejects.toThrow("too many requests");
    const id = lastRequestId(events);
    registry.head(CHANNEL, id, { status: 200, headers: {} });
    const response = await answer;
    expect(registry.chunk(CHANNEL, id, encoder.encode("12345"))).toBe(
      "too-large",
    );
    expect(events.at(-1)).toEqual({ type: "cancel", id });
    await expect(response.text()).rejects.toThrow("too large");
  });
});
