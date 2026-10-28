// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  profiles: [] as Array<{ baseUrl: string }>,
  relaySupported: true,
}));

vi.mock("@/settings/store", () => ({
  getSettings: () => ({
    get: (key: string) =>
      key === "llm.providers" ? state.profiles : undefined,
  }),
}));
vi.mock("@/services/api/health.js", () => ({
  isModelRelaySupported: () => state.relaySupported,
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
});
