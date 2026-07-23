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
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: false,
});

// Must import AFTER localStorage mock is installed
const apiModule = await import("../api.js");
const {
  listSessionPlugins,
  enableSessionPlugin,
  disableSessionPlugin,
  listPackages,
} = apiModule;

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
    // Mock the raw server response (uses `active` and `name`, not `isActive`/`displayName`)
    const serverResponse = {
      active: ["narrator", "persona"],
      available: [
        {
          id: "narrator",
          name: "Narrator",
          description: "Main narrative generation",
          active: true,
        },
        {
          id: "persona",
          name: "Persona",
          active: true,
        },
        {
          id: "memory",
          name: "Memory",
          description: "Memory summarizer",
          active: false,
        },
      ],
    };

    mockFetchOnce(serverResponse);

    const result = await listSessionPlugins("session-123");

    // API layer maps: active→isActive, name→displayName
    expect(result.active).toEqual(["narrator", "persona"]);
    expect(result.available).toHaveLength(3);
    expect(result.available[0].isActive).toBe(true);
    expect(result.available[0].displayName).toBe("Narrator");
    expect(result.available[2].isActive).toBe(false);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/sessions/session-123/plugins",
    );
  });

  it("should URL-encode the sessionId", async () => {
    mockFetchOnce({ active: [], available: [] });

    await listSessionPlugins("session/with/slashes");

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/sessions/session%2Fwith%2Fslashes/plugins",
    );
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
    const mockResponse = { ok: true, active: ["narrator", "memory"] };
    mockFetchOnce(mockResponse);

    const result = await enableSessionPlugin("session-abc", "memory");

    expect(result).toEqual(mockResponse);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/sessions/session-abc/plugins/enable",
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ pluginId: "memory" });
  });

  it("returns the approval envelope from a 202 response", async () => {
    const pending = {
      status: "approval-required" as const,
      approvalId: "approval-1",
      pending: {
        pluginId: "community-memory",
        action: "covel:plugin-server-code",
      },
    };
    mockFetchOnce(pending, 202);

    await expect(
      enableSessionPlugin("session-abc", "community-memory"),
    ).resolves.toEqual(pending);
  });

  it("should throw when server returns 404 (plugin not found)", async () => {
    mockFetchOnce({ code: "PLUGIN_NOT_FOUND" }, 404);

    await expect(
      enableSessionPlugin("session-abc", "nonexistent"),
    ).rejects.toThrow("API 404");
  });

  it("should throw when server returns 400 (invalid request)", async () => {
    mockFetchOnce({ code: "INVALID_REQUEST" }, 400);

    await expect(enableSessionPlugin("session-abc", "")).rejects.toThrow(
      "API 400",
    );
  });
});

describe("disableSessionPlugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorageMock.clear();
  });

  it("should call POST /sessions/:id/plugins/disable with pluginId body", async () => {
    const mockResponse = { ok: true, active: ["narrator"] };
    mockFetchOnce(mockResponse);

    const result = await disableSessionPlugin("session-abc", "memory");

    expect(result).toEqual(mockResponse);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/sessions/session-abc/plugins/disable",
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ pluginId: "memory" });
  });

  it("should throw on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("Network error")),
    );

    await expect(disableSessionPlugin("session-abc", "memory")).rejects.toThrow(
      "Network error",
    );
  });

  it("should URL-encode the sessionId", async () => {
    mockFetchOnce({ ok: true, active: [] });

    await disableSessionPlugin("session with spaces", "memory");

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/sessions/session%20with%20spaces/plugins/disable",
    );
  });
});

describe("listPackages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorageMock.clear();
  });

  it("keeps runtime trigger.type from the server payload", async () => {
    mockFetchOnce({
      packages: [
        {
          name: "narrator",
          enabled: true,
          pluginType: "core-plugin",
          source: "builtin",
          runtimes: [
            {
              id: "narrator",
              kind: "agent",
              trigger: { type: "event", topic: "story.ready" },
              tags: ["mode:traditional-story", "role:narrator"],
              relations: { provides: ["narrative-engine"] },
            },
          ],
          capabilities: ["narrative"],
          tags: ["mode:traditional-story", "role:narrator"],
          relations: { provides: ["narrative-engine"] },
        },
      ],
      loadErrors: [],
    });

    const result = await listPackages();

    expect(result.packages[0]?.source).toBe("builtin");
    expect(result.packages[0]?.capabilities).toEqual(["narrative"]);
    expect(result.packages[0]?.tags).toEqual([
      "mode:traditional-story",
      "role:narrator",
    ]);
    expect(result.packages[0]?.relations).toEqual({
      provides: ["narrative-engine"],
    });
    expect(result.packages[0]?.runtimes?.[0]?.trigger).toEqual({
      type: "event",
      topic: "story.ready",
    });
    expect(result.packages[0]?.runtimes?.[0]?.tags).toEqual([
      "mode:traditional-story",
      "role:narrator",
    ]);
  });
});
