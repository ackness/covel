import { afterEach, describe, expect, it, vi } from "vitest";

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

const apiModule = await import("../api.js");
const {
  generateWorld,
  updateWorld,
  importDimensions,
  preflightWorldData,
  listApprovals,
} = apiModule;
const dataServiceModule = await import("../data-service.js");
const { generatedWorldSaveTargetForStorageMode, storageModeForServerStorage } =
  dataServiceModule;

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
  it("maps structured server storage capabilities to frontend mode", () => {
    expect(
      storageModeForServerStorage({
        data: { backend: "memory", frontendMode: "remote" },
      }),
    ).toBe("remote");
    expect(storageModeForServerStorage({ data: { backend: "pg" } })).toBeNull();
  });

  it("maps frontend storage mode to generated-world save target", () => {
    expect(generatedWorldSaveTargetForStorageMode("local")).toBe("return-only");
    expect(generatedWorldSaveTargetForStorageMode("remote")).toBe(
      "server-store",
    );
    expect(generatedWorldSaveTargetForStorageMode(undefined)).toBe(
      "server-file",
    );
  });

  it("generateWorld sends the requested save target", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"done","world":{"id":"w1","name":"W","description":"D","createdAt":"2026-01-01T00:00:00.000Z"}}\n\n',
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: stream,
      }),
    );
    const events: unknown[] = [];

    generateWorld(
      "idea",
      "zh-CN",
      (event) => events.push(event),
      undefined,
      undefined,
      {
        saveTarget: "return-only",
      },
    );

    await vi.waitFor(() => expect(events).toHaveLength(1));
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/ai/generate-world");
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      prompt: "idea",
      locale: "zh-CN",
      saveTarget: "return-only",
    });
  });

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

  it("preflightWorldData posts selected plugins and returns plan details", async () => {
    mockFetchOnce({
      imported: true,
      diagnostics: [],
      planned: 1,
      targets: [
        {
          kind: "plugin-data",
          target: "plugin:world-notes/facts",
          sourceId: "facts",
          pluginId: "world-notes",
          namespace: "facts",
          key: "one",
        },
      ],
    });

    const result = await preflightWorldData("world/1", {
      plugins: ["world-notes"],
    });

    expect(result.planned).toBe(1);
    expect(result.targets[0]).toMatchObject({
      pluginId: "world-notes",
      namespace: "facts",
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/worlds/world%2F1/world-data/preflight",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      plugins: ["world-notes"],
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
