import { afterEach, describe, expect, it, vi } from "vitest";

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

const apiModule = await import("../api.js");
const { updateWorld, importDimensions, listApprovals } = apiModule;

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

afterEach(() => {
  vi.restoreAllMocks();
  localStorageMock.clear();
});

describe("world API mapping", () => {
  it("updateWorld maps metadata.dimensions onto the frontend record", async () => {
    mockFetchOnce({
      id: "world-1",
      name: "World 1",
      description: "desc",
      metadata: {
        dimensions: {
          geography: { regions: ["North"] },
        },
      },
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    });

    const world = await updateWorld("world-1", {
      dimensions: { geography: { regions: ["North"] } } as never,
    });

    expect(world.dimensions).toEqual({
      geography: { regions: ["North"] },
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/worlds/world-1");
  });

  it("importDimensions maps metadata.dimensions onto the frontend record", async () => {
    mockFetchOnce({
      id: "world-2",
      name: "World 2",
      description: "desc",
      metadata: {
        dimensions: {
          factions: { groups: ["Guild"] },
        },
      },
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    });

    const world = await importDimensions("world-2", {
      factions: { groups: ["Guild"] },
    });

    expect(world.dimensions).toEqual({
      factions: { groups: ["Guild"] },
    });
  });
});

describe("approvals API helpers", () => {
  it("listApprovals reads the pending envelope from the server", async () => {
    mockFetchOnce({
      pending: [
        {
          approvalId: "approval-1",
          sessionId: "sess-1",
          pluginId: "plugin-1",
          action: "run",
          payload: { x: 1 },
          trustLevel: "community",
          requestedAt: "2026-04-22T00:00:00.000Z",
          description: "Run plugin action",
        },
      ],
    });

    const approvals = await listApprovals("sess-1");

    expect(approvals).toEqual([
      {
        approvalId: "approval-1",
        sessionId: "sess-1",
        pluginId: "plugin-1",
        action: "run",
        payload: { x: 1 },
        trustLevel: "community",
        requestedAt: "2026-04-22T00:00:00.000Z",
        description: "Run plugin action",
      },
    ]);
  });
});
