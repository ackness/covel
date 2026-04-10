/**
 * Tests for session plugin API functions in api.ts.
 * Uses vi.fn() to mock global fetch — no real HTTP calls.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock localStorage before any module imports that may read it
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  };
})();

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, writable: false });

// Must import AFTER localStorage mock is installed
const apiModule = await import("../api.js");
const { listSessionPlugins, enableSessionPlugin, disableSessionPlugin } = apiModule;

// ── Helpers ────────────────────────────────────────────────────────

function mockFetchOnce(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

// ── Tests ──────────────────────────────────────────────────────────

describe("listSessionPlugins", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorageMock.clear();
  });

  it("should call GET /sessions/:id/plugins and return the response", async () => {
    const mockResponse = {
      active: ["core-narrator", "core-persona"],
      available: [
        {
          id: "core-narrator",
          displayName: "Narrator",
          description: "Main narrative generation",
          isActive: true,
        },
        {
          id: "core-persona",
          displayName: "Persona",
          description: undefined,
          isActive: true,
        },
        {
          id: "core-memory",
          displayName: "Memory",
          description: "Memory summarizer",
          isActive: false,
        },
      ],
    };

    mockFetchOnce(mockResponse);

    const result = await listSessionPlugins("session-123");

    expect(result).toEqual(mockResponse);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions/session-123/plugins");
  });

  it("should URL-encode the sessionId", async () => {
    mockFetchOnce({ active: [], available: [] });

    await listSessionPlugins("session/with/slashes");

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions/session%2Fwith%2Fslashes/plugins");
  });

  it("should throw on non-200 response", async () => {
    mockFetchOnce({ code: "NOT_FOUND" }, 404);

    await expect(listSessionPlugins("bad-id")).rejects.toThrow("API 404");
  });
});

describe("enableSessionPlugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorageMock.clear();
  });

  it("should call POST /sessions/:id/plugins/enable with pluginId body", async () => {
    const mockResponse = { ok: true, active: ["core-narrator", "core-memory"] };
    mockFetchOnce(mockResponse);

    const result = await enableSessionPlugin("session-abc", "core-memory");

    expect(result).toEqual(mockResponse);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions/session-abc/plugins/enable");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ pluginId: "core-memory" });
  });

  it("should throw when server returns 404 (plugin not found)", async () => {
    mockFetchOnce({ code: "PLUGIN_NOT_FOUND" }, 404);

    await expect(enableSessionPlugin("session-abc", "nonexistent")).rejects.toThrow("API 404");
  });

  it("should throw when server returns 400 (invalid request)", async () => {
    mockFetchOnce({ code: "INVALID_REQUEST" }, 400);

    await expect(enableSessionPlugin("session-abc", "")).rejects.toThrow("API 400");
  });
});

describe("disableSessionPlugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorageMock.clear();
  });

  it("should call POST /sessions/:id/plugins/disable with pluginId body", async () => {
    const mockResponse = { ok: true, active: ["core-narrator"] };
    mockFetchOnce(mockResponse);

    const result = await disableSessionPlugin("session-abc", "core-memory");

    expect(result).toEqual(mockResponse);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions/session-abc/plugins/disable");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ pluginId: "core-memory" });
  });

  it("should throw on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("Network error")));

    await expect(disableSessionPlugin("session-abc", "core-memory")).rejects.toThrow("Network error");
  });

  it("should URL-encode the sessionId", async () => {
    mockFetchOnce({ ok: true, active: [] });

    await disableSessionPlugin("session with spaces", "core-memory");

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions/session%20with%20spaces/plugins/disable");
  });
});
