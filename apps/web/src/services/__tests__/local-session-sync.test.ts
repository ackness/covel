import { createMemoryStore, type DataStore } from "@covel/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getWorld: vi.fn(),
  createWorld: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  syncMessages: vi.fn(),
  saveStateSnapshot: vi.fn(),
}));

const appKv = vi.hoisted(() => ({
  getStatePatches: vi.fn(async () => null),
  saveStatePatches: vi.fn(async () => {}),
  removeStatePatches: vi.fn(async () => {}),
  getStateSnapshot: vi.fn(async () => null as Record<string, unknown> | null),
  saveStateSnapshot: vi.fn(async () => {}),
  removeStateSnapshot: vi.fn(async () => {}),
  getSubmittedBlocks: vi.fn(async () => null),
  saveSubmittedBlocks: vi.fn(async () => {}),
  removeSubmittedBlocks: vi.fn(async () => {}),
  getWorldOverlay: vi.fn(async () => null),
  saveWorldOverlay: vi.fn(async () => {}),
  migrateLocalStorageToIdb: vi.fn(async () => {}),
}));

vi.mock("../api.js", () => api);
vi.mock("../api/request.js", () => ({
  isNotFound: () => true,
}));
vi.mock("../app-kv-store.js", () => appKv);

const { LocalDataService } = await import("../data-service/local.js");

function withStore(store: DataStore): InstanceType<typeof LocalDataService> {
  const service = new LocalDataService();
  (
    service as unknown as {
      idbStore: DataStore;
    }
  ).idbStore = store;
  return service;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getWorld.mockResolvedValue({ id: "world-1" });
  api.getSession.mockRejectedValue(new Error("404"));
  api.createSession.mockResolvedValue({ id: "sess-1" });
  api.deleteSession.mockResolvedValue(undefined);
  api.syncMessages.mockResolvedValue(undefined);
  api.saveStateSnapshot.mockResolvedValue(undefined);
  appKv.getStateSnapshot.mockResolvedValue(null);
});

describe("LocalDataService session sync", () => {
  it("returns the locally persisted plugin set and locale", async () => {
    const service = withStore(createMemoryStore());

    const session = await service.createSession(
      "world-1",
      "preset-1",
      "ignored-id",
      ["pregame", "world-init", "scene-stage"],
      "en-US",
    );

    expect(session).toMatchObject({
      activePlugins: ["pregame", "world-init", "scene-stage"],
      locale: "en-US",
    });
    await expect(service.getSession(session.id)).resolves.toMatchObject({
      activePlugins: ["pregame", "world-init", "scene-stage"],
      locale: "en-US",
    });
  });

  it("creates the server mirror with the selected plugins and locale", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "world-1",
      name: "World",
      description: "",
      createdAt: now,
      updatedAt: now,
    });
    await store.createSession({
      id: "sess-1",
      worldId: "world-1",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      activePlugins: ["pregame", "world-init", "scene-stage"],
      locale: "en-US",
      presetId: "preset-1",
      createdAt: now,
      updatedAt: now,
    });
    const service = withStore(store);

    await service.syncToServer("sess-1");

    expect(api.createSession).toHaveBeenCalledWith(
      "world-1",
      "preset-1",
      "sess-1",
      ["pregame", "world-init", "scene-stage"],
      "en-US",
    );
  });

  it("preserves legacy underscore IDs when creating the server mirror", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "world_legacy",
      name: "World",
      description: "",
      createdAt: now,
      updatedAt: now,
    });
    await store.createSession({
      id: "session_legacy",
      worldId: "world_legacy",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      activePlugins: [],
      locale: "en-US",
      createdAt: now,
      updatedAt: now,
    });
    const service = withStore(store);

    await service.syncToServer("session_legacy");

    expect(api.getWorld).toHaveBeenCalledWith("world_legacy");
    expect(api.getSession).toHaveBeenCalledWith("session_legacy");
    expect(api.createSession).toHaveBeenCalledWith(
      "world_legacy",
      undefined,
      "session_legacy",
      [],
      "en-US",
    );
  });

  it("keeps legacy snapshots local instead of calling the unsupported server endpoint", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "world-1",
      name: "World",
      description: "",
      createdAt: now,
      updatedAt: now,
    });
    await store.createSession({
      id: "sess-1",
      worldId: "world-1",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      activePlugins: [],
      locale: "en-US",
      createdAt: now,
      updatedAt: now,
    });
    appKv.getStateSnapshot.mockResolvedValueOnce({ state: { hp: 100 } });
    const service = withStore(store);

    await service.syncToServer("sess-1");

    expect(api.saveStateSnapshot).not.toHaveBeenCalled();
    expect(appKv.getStateSnapshot).not.toHaveBeenCalled();
    await expect(service.loadStateSnapshot("sess-1")).resolves.toEqual({
      state: { hp: 100 },
    });
  });

  it("deletes both the local session and its server mirror", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: "sess-1",
      worldId: "world-1",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      activePlugins: [],
      locale: "en-US",
      createdAt: now,
      updatedAt: now,
    });
    const service = withStore(store);

    await service.deleteSession("sess-1");

    await expect(store.getSession("sess-1")).resolves.toBeNull();
    expect(api.deleteSession).toHaveBeenCalledWith("sess-1");
  });
});
