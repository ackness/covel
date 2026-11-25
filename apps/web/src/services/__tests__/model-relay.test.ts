// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  profiles: [] as Array<{ baseUrl: string }>,
  relaySupported: true,
  providerListeners: new Set<() => void>(),
  supportedListeners: new Set<(supported: boolean) => void>(),
}));

vi.mock("@/settings/store", () => ({
  getSettings: () => ({
    get: (key: string) =>
      key === "llm.providers" ? state.profiles : undefined,
    subscribe: (key: string, handler: () => void) => {
      if (key === "llm.providers") state.providerListeners.add(handler);
      return () => {
        state.providerListeners.delete(handler);
      };
    },
  }),
}));
vi.mock("@/services/api/server-capabilities.js", () => ({
  isModelRelaySupported: () => state.relaySupported,
  onModelRelaySupportedChange: (handler: (supported: boolean) => void) => {
    state.supportedListeners.add(handler);
    return () => {
      state.supportedListeners.delete(handler);
    };
  },
}));

const { modelRelayHeaders, relayEndpoints, relayRefusal } =
  await import("../model-relay.js");

afterEach(() => {
  vi.unstubAllGlobals();
  state.profiles = [];
  state.relaySupported = true;
});

describe("relayRefusal", () => {
  const endpoints = [
    new URL("http://127.0.0.1:3425/v1"),
    new URL("https://192.168.1.20/api"),
  ];

  it.each([
    "http://127.0.0.1:3425/v1/chat/completions",
    "http://127.0.0.1:3425/v1/models",
    "https://192.168.1.20/api/v1/chat",
  ])("relays %s under a configured endpoint", (url) => {
    expect(relayRefusal({ url, method: "POST" }, endpoints)).toBeUndefined();
  });

  it.each([
    // Another port or path on the same machine.
    "http://127.0.0.1:22/",
    "http://127.0.0.1:3425/admin",
    "http://localhost:3425/v1/models",
    // Anything public, even if the server asks.
    "https://api.example.com/v1/chat/completions",
  ])("refuses %s", (url) => {
    expect(relayRefusal({ url, method: "POST" }, endpoints)).toMatch(
      /relays only to the model endpoints you added/,
    );
  });

  it("refuses encoded separators and the IPv6 loopback over http", () => {
    expect(
      relayRefusal(
        { url: "http://127.0.0.1:3425/v1/..%2fapi%2fpull", method: "POST" },
        endpoints,
      ),
    ).toMatch(/encoded separators/);
    expect(
      relayRefusal({ url: "http://[::1]:3425/v1/models", method: "GET" }, [
        new URL("http://[::1]:3425/v1"),
      ]),
    ).toMatch(/use http:\/\/127\.0\.0\.1/);
  });

  it("refuses other methods and plain-http LAN addresses", () => {
    expect(
      relayRefusal(
        { url: "http://127.0.0.1:3425/v1/models", method: "DELETE" },
        endpoints,
      ),
    ).toMatch(/only GET and POST/);
    expect(
      relayRefusal({ url: "http://192.168.1.30/v1/models", method: "GET" }, [
        new URL("http://192.168.1.30/v1"),
      ]),
    ).toMatch(/plain-http address on your local network/);
  });
});

describe("relayEndpoints and the channel header", () => {
  it("lists only the player's local endpoints and names the channel only when wanted", () => {
    state.profiles = [
      { baseUrl: "https://api.openai.com/v1" },
      { baseUrl: "http://127.0.0.1:3425/v1" },
    ];
    expect(relayEndpoints().map((url) => url.href)).toEqual([
      "http://127.0.0.1:3425/v1",
    ]);
    state.relaySupported = false;
    expect(modelRelayHeaders()).toEqual({});
    state.relaySupported = true;
    state.profiles = [{ baseUrl: "https://api.openai.com/v1" }];
    expect(modelRelayHeaders()).toEqual({});
  });

  it("makes an allowed request and posts the answer; never fetches a refused one", async () => {
    state.profiles = [{ baseUrl: "http://127.0.0.1:3425/v1" }];
    const posts: Array<{ url: string; body: unknown }> = [];
    const fetched: string[] = [];
    const encoder = new TextEncoder();
    const events = [
      {
        type: "request",
        id: "allowed",
        url: "http://127.0.0.1:3425/v1/models",
        method: "GET",
        headers: { authorization: "Bearer sk-local", cookie: "secret" },
      },
      {
        type: "request",
        id: "refused",
        url: "http://127.0.0.1:22/",
        method: "GET",
        headers: {},
      },
    ];
    let seenInit: RequestInit | undefined;
    vi.stubGlobal("window", { location: { origin: "https://demo.covel.cc" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/model-relay/stream") {
          state.relaySupported = false; // let the channel loop end after this stream
          const body = events
            .map(
              (event) => `event: request\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join("");
          return new Response(encoder.encode(body), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (url.startsWith("/api/model-relay/requests/")) {
          const raw = init?.body;
          posts.push({
            url,
            body:
              typeof raw === "string"
                ? JSON.parse(raw)
                : raw instanceof Uint8Array
                  ? new TextDecoder().decode(raw)
                  : undefined,
          });
          return new Response(null, { status: 204 });
        }
        fetched.push(url);
        seenInit = init;
        return new Response('{"data":[]}', {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    expect(modelRelayHeaders()["X-Model-Relay"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await vi.waitFor(() => {
      expect(posts.map((post) => post.url)).toEqual(
        expect.arrayContaining([
          "/api/model-relay/requests/allowed/head",
          "/api/model-relay/requests/allowed/chunk",
          "/api/model-relay/requests/allowed/end",
          "/api/model-relay/requests/refused/fail",
        ]),
      );
    });
    expect(fetched).toEqual(["http://127.0.0.1:3425/v1/models"]);
    expect(seenInit).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
    });
    expect(seenInit?.headers).toEqual({ authorization: "Bearer sk-local" });
    const byUrl = Object.fromEntries(
      posts.map((post) => [post.url, post.body]),
    );
    expect(byUrl["/api/model-relay/requests/allowed/head"]).toMatchObject({
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(byUrl["/api/model-relay/requests/allowed/chunk"]).toBe(
      '{"data":[]}',
    );
    expect(byUrl["/api/model-relay/requests/refused/fail"]).toMatchObject({
      message: expect.stringContaining("http://127.0.0.1:22"),
    });
  });

  it("closes the SSE stream and aborts in-flight local fetches when local endpoints are removed, and resets the 404 latch", async () => {
    vi.resetModules();
    state.providerListeners.clear();
    state.supportedListeners.clear();
    state.profiles = [{ baseUrl: "http://127.0.0.1:3425/v1" }];
    state.relaySupported = true;

    let streamSignal: AbortSignal | undefined;
    let localSignal: AbortSignal | undefined;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let streamCalls = 0;

    vi.stubGlobal("window", { location: { origin: "https://demo.covel.cc" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/model-relay/stream") {
          streamCalls += 1;
          streamSignal = init?.signal ?? undefined;
          if (streamCalls === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(c) {
                  streamController = c;
                  streamSignal?.addEventListener(
                    "abort",
                    () => c.error(new DOMException("Aborted", "AbortError")),
                    { once: true },
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          // Second stream call returns 404 to trigger the unsupported latch.
          return new Response(null, { status: 404 });
        }
        if (url.startsWith("/api/model-relay/requests/")) {
          return new Response(null, { status: 204 });
        }
        localSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          localSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );

    const mod = await import("../model-relay.js");
    expect(mod.modelRelayHeaders()["X-Model-Relay"]).toBeTruthy();
    await vi.waitFor(() => expect(streamCalls).toBe(1));

    // Dispatch a local request that stays in flight until aborted.
    streamController.enqueue(
      new TextEncoder().encode(
        `event: request\ndata: ${JSON.stringify({
          type: "request",
          id: "slow-req",
          url: "http://127.0.0.1:3425/v1/chat/completions",
          method: "POST",
          headers: {},
        })}\n\n`,
      ),
    );
    await vi.waitFor(() => expect(localSignal).toBeDefined());

    // Removing local endpoints aborts both the SSE stream and the in-flight local fetch.
    state.profiles = [{ baseUrl: "https://api.openai.com/v1" }];
    for (const listener of state.providerListeners) listener();
    expect(streamSignal?.aborted).toBe(true);
    expect(localSignal?.aborted).toBe(true);

    // Re-adding a local endpoint opens a new stream, hits 404 (latching unsupported),
    // and a subsequent health capability update clears the latch.
    state.profiles = [{ baseUrl: "http://127.0.0.1:3425/v1" }];
    for (const listener of state.providerListeners) listener();
    expect(mod.modelRelayHeaders()["X-Model-Relay"]).toBeTruthy();
    await vi.waitFor(() => expect(streamCalls).toBe(2));
    await vi.waitFor(() => expect(mod.modelRelayHeaders()).toEqual({}));

    for (const listener of state.supportedListeners) listener(true);
    expect(mod.modelRelayHeaders()["X-Model-Relay"]).toBeTruthy();
  });
});
