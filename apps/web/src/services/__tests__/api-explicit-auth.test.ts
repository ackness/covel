import { clearSessionCredentialFixtures } from "../../test/session-credentials.js";
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

beforeEach(async () => {
  localStorageMock.clear();
  await clearSessionCredentialFixtures();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorageMock.clear();
});

describe("explicit session auth on indirect routes", () => {
  it("retries restored form submissions with the same values and both credentials", async () => {
    await api.storeSessionToken("sess-1", "synthetic-owner");
    api.storeOperatorToken("synthetic-operator");
    const result = { results: [{ interactionId: "form", accepted: true }] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ status: "approval-required", approvalId: "approval" }),
      )
      .mockResolvedValueOnce(okJson({ status: "ok", result }));
    vi.stubGlobal("fetch", fetchMock);
    const resolveResponse = vi.fn(async (response, retry) => {
      expect(response.status).toBe("approval-required");
      return retry();
    });
    expect(
      await api.submitInputs(
        "sess-1",
        {
          turnId: "turn",
          submissions: [
            { interactionId: "form", type: "form", values: { points: 4 } },
          ],
        },
        resolveResponse,
      ),
    ).toEqual(result);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    for (const index of [0, 1]) {
      expect(headersAt(fetchMock, index).get("Authorization")).toBe(
        "Bearer synthetic-operator",
      );
      expect(headersAt(fetchMock, index).get("X-Session-Token")).toBe(
        "synthetic-owner",
      );
    }
  });
  it("retries an action only after each exact approval and preserves its request id", async () => {
    const pending = (action: string) => ({
      ...okJson({
        status: "approval-required",
        approvalId: action,
        pending: { sessionId: "sess-1", pluginId: "external", action },
      }),
      status: 202,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pending("covel:plugin-server-code"))
      .mockResolvedValueOnce(pending("runtime:external/create"))
      .mockResolvedValueOnce({
        ...okJson(),
        body: new ReadableStream({ start: (controller) => controller.close() }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const approve = vi.fn(async () => true);
    const done = vi.fn();
    const error = vi.fn();
    api.sendAction(
      {
        requestId: "original",
        sessionId: "sess-1",
        type: "start_session",
        payload: {},
      },
      vi.fn(),
      error,
      done,
      approve,
    );
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(error).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).requestId),
    ).toEqual(["original", "original", "original"]);
  });

  it.each(["denied", "repeated", "foreign"])(
    "does not execute past a %s action approval",
    async (mode) => {
      const pending = {
        ...okJson({
          status: "approval-required",
          approvalId: "a",
          pending: {
            sessionId: mode === "foreign" ? "other" : "sess-1",
            pluginId: "external",
            action: "runtime:external/create",
          },
        }),
        status: 202,
      };
      const fetchMock = vi.fn().mockResolvedValue(pending);
      vi.stubGlobal("fetch", fetchMock);
      const approve = vi.fn(async () => mode !== "denied");
      const done = vi.fn();
      const error = vi.fn();
      api.sendAction(
        {
          requestId: "original",
          sessionId: "sess-1",
          type: "start_session",
          payload: {},
        },
        vi.fn(),
        error,
        done,
        approve,
      );
      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
      expect(done).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(mode === "repeated" ? 2 : 1);
      expect(approve).toHaveBeenCalledTimes(mode === "foreign" ? 0 : 1);
    },
  );

  it("authenticates action, steer, abort, media upload, UI specs, and traces", async () => {
    await api.storeSessionToken("sess-1", "owner-secret");
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
    expect(await api.getSessionToken("sess-1")).toBe("owner-secret");
  });
});
