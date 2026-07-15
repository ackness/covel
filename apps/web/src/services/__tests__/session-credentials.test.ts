import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const {
  clearOperatorToken,
  clearSessionToken,
  getOperatorToken,
  getSessionToken,
  storeOperatorToken,
  storeSessionToken,
} = await import("../session-credentials.js");
const { request } = await import("../api/request.js");

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("session-credentials store", () => {
  it("persists and reads a token per sessionId", () => {
    storeSessionToken("world-abc12345", "tok-1");
    storeSessionToken("world-def67890", "tok-2");

    expect(getSessionToken("world-abc12345")).toBe("tok-1");
    expect(getSessionToken("world-def67890")).toBe("tok-2");
    expect(getSessionToken("unknown")).toBeUndefined();
  });

  it("overwrites the token for an existing sessionId atomically", () => {
    storeSessionToken("s1", "old");
    storeSessionToken("s2", "keep");
    storeSessionToken("s1", "new");

    expect(getSessionToken("s1")).toBe("new");
    // Sibling key survives the rewrite.
    expect(getSessionToken("s2")).toBe("keep");
  });

  it("ignores empty sessionId or token", () => {
    storeSessionToken("", "tok");
    storeSessionToken("s1", "");
    expect(getSessionToken("")).toBeUndefined();
    expect(getSessionToken("s1")).toBeUndefined();
  });

  it("clears a token and is a no-op when absent", () => {
    storeSessionToken("s1", "tok");
    clearSessionToken("s1");
    expect(getSessionToken("s1")).toBeUndefined();
    // No throw / no corruption on a missing key.
    expect(() => clearSessionToken("never-existed")).not.toThrow();
  });

  it("tolerates corrupt persisted JSON", () => {
    localStorage.setItem("covel:session-tokens", "{not json");
    expect(getSessionToken("s1")).toBeUndefined();
    // A fresh write recovers cleanly.
    storeSessionToken("s1", "tok");
    expect(getSessionToken("s1")).toBe("tok");
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

  function lastHeaders(mock: ReturnType<typeof vi.fn>): Record<string, string> {
    return (mock.mock.calls.at(-1)?.[1]?.headers ?? {}) as Record<
      string,
      string
    >;
  }

  it("attaches X-Session-Token for a session-scoped path", async () => {
    storeSessionToken("world-abc12345", "tok-xyz");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/sessions/world-abc12345/snapshot");

    expect(lastHeaders(fetchMock)["X-Session-Token"]).toBe("tok-xyz");
  });

  it("decodes an encoded id segment before lookup", async () => {
    storeSessionToken("world-abc12345", "tok-xyz");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request(
      `/api/sessions/${encodeURIComponent("world-abc12345")}/messages`,
    );

    expect(lastHeaders(fetchMock)["X-Session-Token"]).toBe("tok-xyz");
  });

  it("omits the header when no token is stored", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/sessions/world-notoken/snapshot");

    expect(lastHeaders(fetchMock)["X-Session-Token"]).toBeUndefined();
  });

  it("omits the header for non-session-scoped paths", async () => {
    storeSessionToken("world-abc12345", "tok-xyz");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    // Cross-session list endpoint — no id segment to key on.
    await request("/api/sessions?worldId=world");

    expect(lastHeaders(fetchMock)["X-Session-Token"]).toBeUndefined();
  });

  it("attaches a session token when sessionId is explicit", async () => {
    storeSessionToken("session-from-body", "owner-secret");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/actions", { sessionId: "session-from-body" });

    expect(lastHeaders(fetchMock)["X-Session-Token"]).toBe("owner-secret");
  });

  it("attaches the operator token only when explicitly requested", async () => {
    storeOperatorToken("operator-secret");
    const fetchMock = vi.fn().mockResolvedValue(okRes());
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/worlds", { method: "POST", operatorAuth: true });
    expect(lastHeaders(fetchMock).Authorization).toBe("Bearer operator-secret");

    await request("/api/worlds");
    expect(lastHeaders(fetchMock).Authorization).toBeUndefined();
  });
});
