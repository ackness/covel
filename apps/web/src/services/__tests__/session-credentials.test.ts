import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionCredentialFixtures } from "../../test/session-credentials.js";
import Dexie from "dexie";

// jsdom here does not expose localStorage by default (see sibling tests) —
// install a minimal in-memory mock before importing the modules under test.
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
  writable: false,
  configurable: true,
});

const credentials = await import("../session-credentials.js");
const {
  clearOperatorToken,
  clearSessionToken,
  getOperatorToken,
  getSessionToken,
  storeOperatorToken,
  storeSessionToken,
  SESSION_CREDENTIAL_DB_NAME,
} = credentials;
const { request } = await import("../api/request.js");
const { createSession, deleteSession } = await import("../api/sessions.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("credential ownership across HTTP responses", () => {
  it("preserves a replacement token after an older delete response arrives", async () => {
    await storeSessionToken("same-id", "old-owner");
    const entered = deferred<void>();
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockImplementation(() => {
      entered.resolve();
      return response.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = deleteSession("same-id");
    await entered.promise;
    await storeSessionToken("same-id", "new-owner");
    response.resolve(Response.json({ ok: true }));
    await pending;
    expect(await getSessionToken("same-id")).toBe("new-owner");
    expect(
      new Headers(fetchMock.mock.calls[0][1].headers).get("X-Session-Token"),
    ).toBe("old-owner");
  });

  it("does not overwrite a newer creation credential with a delayed creation response", async () => {
    const entered = deferred<void>();
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => {
          entered.resolve();
          return response.promise;
        })
        .mockResolvedValueOnce(
          Response.json({
            id: "same-id",
            ownerToken: "new-owner",
            incarnation: "new",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ id: "same-id", incarnation: "new" }),
        ),
    );
    const pending = createSession("world", undefined, "same-id").then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    await createSession("world", undefined, "same-id");
    response.resolve(
      Response.json({
        id: "same-id",
        ownerToken: "old-owner",
        incarnation: "old",
      }),
    );
    expect(await pending).toMatchObject({
      message: "Session credential changed during creation",
    });
    expect(await getSessionToken("same-id")).toBe("new-owner");
  });

  it.each([undefined, "old-owner"])(
    "uses the captured delete credential even if it changes before transport (%s)",
    async (captured) => {
      if (captured) await storeSessionToken("same-id", captured);
      vi.spyOn(credentials, "getSessionToken").mockImplementationOnce(
        async () => {
          await storeSessionToken("same-id", "new-owner");
          return captured;
        },
      );
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);
      await deleteSession("same-id");
      expect(
        new Headers(fetchMock.mock.calls[0][1].headers).get("X-Session-Token"),
      ).toBe(captured ?? "");
      expect(await getSessionToken("same-id")).toBe("new-owner");
    },
  );

  it.each([401, 500])(
    "retains credentials after a failed delete (%i)",
    async (status) => {
      await storeSessionToken("same-id", "old-owner");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            Response.json({ error: "Synthetic failure" }, { status }),
          ),
      );
      await expect(
        deleteSession("same-id", { silentErrors: true }),
      ).rejects.toMatchObject({ status });
      expect(await getSessionToken("same-id")).toBe("old-owner");
    },
  );

  it("keeps authoritative deletion successful if credential cleanup aborts, then retries on absence", async () => {
    await storeSessionToken("same-id", "old-owner");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Dexie.prototype, "transaction").mockRejectedValueOnce(
      new DOMException("Synthetic abort", "AbortError"),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true }))
        .mockResolvedValueOnce(
          Response.json({ error: "Missing" }, { status: 404 }),
        ),
    );
    await deleteSession("same-id");
    expect(warn).toHaveBeenCalled();
    expect(await getSessionToken("same-id")).toBe("old-owner");
    await expect(
      deleteSession("same-id", { silentErrors: true }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await getSessionToken("same-id")).toBeUndefined();
  });

  it("does not create server state when credential storage cannot open", async () => {
    vi.spyOn(Dexie.prototype, "open").mockRejectedValueOnce(
      new DOMException("Synthetic storage failure", "UnknownError"),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createSession("world")).rejects.toThrow(
      "Synthetic storage failure",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops before transport when cancelled during credential lookup", async () => {
    const entered = deferred<void>();
    const release = deferred<Record<string, string>>();
    vi.spyOn(credentials, "sessionAuthHeaders").mockImplementationOnce(
      async () => {
        entered.resolve();
        return release.promise;
      },
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const reason = new Error("Synthetic navigation");
    const pending = request("/api/sessions/same-id", {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    try {
      await rejected;
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      release.resolve({ "X-Session-Token": "old-owner" });
    }
  });

  it("does not retry a credential lookup failure as a transport failure", async () => {
    vi.spyOn(Dexie.prototype, "open").mockRejectedValueOnce(
      new DOMException("Synthetic storage failure", "UnknownError"),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      request("/api/sessions/same-id", { silentErrors: true }),
    ).rejects.toThrow("Synthetic storage failure");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps one captured credential across transport retries", async () => {
    await storeSessionToken("same-id", "old-owner");
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        await storeSessionToken("same-id", "new-owner");
        return Response.json(
          { error: "Synthetic gateway restart" },
          { status: 503 },
        );
      })
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await request("/api/sessions/same-id");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get("X-Session-Token")).toBe(
        "old-owner",
      );
    }
    expect(await getSessionToken("same-id")).toBe("new-owner");
  });
});

beforeEach(async () => {
  await clearSessionCredentialFixtures();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("session-credentials store", () => {
  it("preserves concurrent sibling writes and compares deletion atomically across connections", async () => {
    await storeSessionToken("same-id", "old-owner");
    const second = await new Dexie(SESSION_CREDENTIAL_DB_NAME).open();
    try {
      await Promise.all([
        storeSessionToken("sibling", "sibling-owner"),
        second
          .table("sessions")
          .put({ sessionId: "same-id", token: "new-owner" }),
        clearSessionToken("same-id", "old-owner"),
      ]);
      expect(await getSessionToken("same-id")).toBe("new-owner");
      expect(await getSessionToken("sibling")).toBe("sibling-owner");
    } finally {
      second.close();
    }
  });

  it("rejects malformed persisted credentials without sending or logging their values", async () => {
    const db = await new Dexie(SESSION_CREDENTIAL_DB_NAME).open();
    try {
      await db.table("sessions").put({
        sessionId: "same-id",
        token: { privateValue: "synthetic-private" },
      });
      await expect(getSessionToken("same-id")).rejects.toThrow(
        /^Invalid session credential record$/,
      );
    } finally {
      db.close();
    }
  });
  it("persists and reads a token per sessionId", async () => {
    await storeSessionToken("world-abc12345", "tok-1");
    await storeSessionToken("world-def67890", "tok-2");

    expect(await getSessionToken("world-abc12345")).toBe("tok-1");
    expect(await getSessionToken("world-def67890")).toBe("tok-2");
    expect(await getSessionToken("unknown")).toBeUndefined();
  });

  it("overwrites only the addressed session credential", async () => {
    await storeSessionToken("s1", "old");
    await storeSessionToken("s2", "keep");
    await storeSessionToken("s1", "new");

    expect(await getSessionToken("s1")).toBe("new");
    // Sibling key survives the rewrite.
    expect(await getSessionToken("s2")).toBe("keep");
  });

  it("ignores empty sessionId or token", async () => {
    await storeSessionToken("", "tok");
    await storeSessionToken("s1", "");
    expect(await getSessionToken("")).toBeUndefined();
    expect(await getSessionToken("s1")).toBeUndefined();
  });

  it("clears a captured token and is a no-op when absent", async () => {
    await storeSessionToken("s1", "tok");
    await clearSessionToken("s1", "tok");
    expect(await getSessionToken("s1")).toBeUndefined();
    // No throw / no corruption on a missing key.
    await expect(
      clearSessionToken("never-existed", undefined),
    ).resolves.toBeUndefined();
  });
});

describe("operator credential store", () => {
  it("persists, reads, and clears the hosted operator token", () => {
    storeOperatorToken("operator-secret");
    expect(getOperatorToken()).toBe("operator-secret");
    clearOperatorToken();
    expect(getOperatorToken()).toBeUndefined();
  });

  it("ignores an empty operator token", () => {
    storeOperatorToken("");
    expect(getOperatorToken()).toBeUndefined();
  });
});

describe("request() session-token injection", () => {
  const okRes = () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    text: async () => "{}",
  });

  function lastHeaders(mock: ReturnType<typeof vi.fn>): Headers {
    return new Headers(mock.mock.calls.at(-1)?.[1]?.headers);
  }

  it("attaches X-Session-Token for a session-scoped path", async () => {
    await storeSessionToken("world-abc12345", "tok-xyz");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/sessions/world-abc12345/view");

    expect(lastHeaders(fetchMock).get("X-Session-Token")).toBe("tok-xyz");
  });

  it("decodes an encoded id segment before lookup", async () => {
    await storeSessionToken("world-abc12345", "tok-xyz");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request(
      `/api/sessions/${encodeURIComponent("world-abc12345")}/messages`,
    );

    expect(lastHeaders(fetchMock).get("X-Session-Token")).toBe("tok-xyz");
  });

  it("omits the header when no token is stored", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/sessions/world-notoken/view");

    expect(lastHeaders(fetchMock).get("X-Session-Token")).toBeNull();
  });

  it("omits the header for non-session-scoped paths", async () => {
    await storeSessionToken("world-abc12345", "tok-xyz");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    // Cross-session list endpoint — no id segment to key on.
    await request("/api/sessions?worldId=world");

    expect(lastHeaders(fetchMock).get("X-Session-Token")).toBeNull();
  });

  it("attaches a session token when sessionId is explicit", async () => {
    await storeSessionToken("session-from-body", "owner-secret");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/actions", { sessionId: "session-from-body" });

    expect(lastHeaders(fetchMock).get("X-Session-Token")).toBe("owner-secret");
  });

  it("attaches the operator token only when explicitly requested", async () => {
    storeOperatorToken("operator-secret");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/worlds", { method: "POST", operatorAuth: true });
    expect(lastHeaders(fetchMock).get("Authorization")).toBe(
      "Bearer operator-secret",
    );

    await request("/api/worlds");
    expect(lastHeaders(fetchMock).get("Authorization")).toBeNull();
  });
});
