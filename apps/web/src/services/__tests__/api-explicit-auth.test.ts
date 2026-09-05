import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

const api = await import("../api.js");

function okJson(body: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function errorJson(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function headersAt(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  return new Headers(fetchMock.mock.calls[index]?.[1]?.headers);
}

beforeEach(() => localStorageMock.clear());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorageMock.clear();
});

describe("explicit session auth on indirect routes", () => {
  it("authenticates action, steer, abort, media upload, UI specs, and traces", async () => {
    api.storeSessionToken("sess-1", "owner-secret");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ...okJson(),
        body: new ReadableStream({ start: (controller) => controller.close() }),
      })
      .mockResolvedValueOnce(okJson())
      .mockResolvedValueOnce(okJson())
      .mockResolvedValueOnce(okJson({ id: "media-1" }))
      .mockResolvedValueOnce(okJson({ right: [] }))
      .mockResolvedValueOnce(okJson({ events: [] }));
    vi.stubGlobal("fetch", fetchMock);

    api.sendAction(
      {
        requestId: "req-1",
        type: "send_message",
        sessionId: "sess-1",
        payload: { content: "hello" },
      },
      () => {},
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await api.steerTurn("sess-1", "hello");
    await api.abortTurn("sess-1");
    await api.uploadSessionMedia(
      "sess-1",
      new File(["image"], "image.png", { type: "image/png" }),
    );
    await api.fetchUiSpecs("sess-1");
    await api.fetchTraceTurns("sess-1");

    for (let index = 0; index < 6; index++) {
      expect(headersAt(fetchMock, index).get("X-Session-Token")).toBe(
        "owner-secret",
      );
    }
  });

  it("surfaces an invalid action SSE envelope through onError", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"runtime.completed"}\n\n'),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ...okJson(),
        body: stream,
      }),
    );
    const onError = vi.fn();

    api.sendAction(
      {
        requestId: "req-invalid-sse",
        type: "retry_turn",
        sessionId: "sess-1",
        payload: {},
      },
      () => {},
      onError,
    );

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });

  it.each(["steerTurn", "abortTurn"] as const)(
    "treats only a 409 from %s as an inactive turn",
    async (method) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          errorJson(409, { error: "No active turn", code: "no_active_turn" }),
        )
        .mockResolvedValueOnce(
          errorJson(500, { error: "Internal server error" }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const invoke = () =>
        method === "steerTurn"
          ? api.steerTurn("sess-1", "hello")
          : api.abortTurn("sess-1");

      await expect(invoke()).resolves.toBe(false);
      await expect(invoke()).rejects.toMatchObject({ status: 500 });
    },
  );
});

describe("operator auth on hosted administration routes", () => {
  it("authenticates session, model, install, key, and uninstall calls", async () => {
    api.storeOperatorToken("operator-secret");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(
        okJson({
          id: "sess-1",
          ownerToken: "owner-secret",
          worldId: "world-1",
        }),
      )
      .mockResolvedValueOnce(okJson({ ok: true }))
      .mockResolvedValueOnce(okJson({ ok: true, latencyMs: 10 }))
      .mockResolvedValueOnce(
        okJson({
          ok: true,
          kind: "plugin",
          id: "fixture-plugin",
          restartRequired: true,
        }),
      )
      .mockResolvedValueOnce(
        okJson({
          keys: { openai: "secret" },
          providers: {
            openai: { configured: true, masked: "****" },
          },
        }),
      )
      .mockResolvedValueOnce(okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.listSessions("world-1");
    await api.createSession("world-1");
    await api.refreshModelDb();
    await api.pingPreset("preset-1");
    await api.installPackage(
      "plugin",
      new File(["zip"], "fixture.zip", { type: "application/zip" }),
    );
    await api.fetchServerProviderKeys();
    await api.uninstallPlugin("fixture-plugin");

    for (let index = 0; index < 7; index++) {
      expect(headersAt(fetchMock, index).get("Authorization")).toBe(
        "Bearer operator-secret",
      );
    }
    expect(headersAt(fetchMock, 4).get("Content-Type")).toBeNull();
    expect(fetchMock.mock.calls[4]?.[1]?.body).toBeInstanceOf(FormData);
    expect(api.getSessionToken("sess-1")).toBe("owner-secret");
  });
});
