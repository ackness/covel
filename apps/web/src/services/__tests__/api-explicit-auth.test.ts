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

function headersAt(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  return (fetchMock.mock.calls[index]?.[1]?.headers ?? {}) as Record<
    string,
    string
  >;
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
        payload: {},
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
      expect(headersAt(fetchMock, index)["X-Session-Token"]).toBe(
        "owner-secret",
      );
    }
  });
});

describe("operator auth on hosted administration routes", () => {
  it("authenticates session list/create, model refresh, and provider ping", async () => {
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
      .mockResolvedValueOnce(okJson({ ok: true, latencyMs: 10 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.listSessions("world-1");
    await api.createSession("world-1");
    await api.refreshModelDb();
    await api.pingPreset("preset-1");

    for (let index = 0; index < 4; index++) {
      expect(headersAt(fetchMock, index).Authorization).toBe(
        "Bearer operator-secret",
      );
    }
    expect(api.getSessionToken("sess-1")).toBe("owner-secret");
  });
});
