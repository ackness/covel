import { createMemoryStore, type DataStore } from "@covel/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getWorld: vi.fn(),
  createWorld: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  syncMessages: vi.fn(),
}));

vi.mock("../api.js", () => api);
vi.mock("../api/request.js", () => ({
  isNotFound: () => true,
}));
vi.mock("../app-kv-store.js", () => ({
  getStatePatches: vi.fn(async () => null),
  saveStatePatches: vi.fn(async () => {}),
  removeStatePatches: vi.fn(async () => {}),
  getStateSnapshot: vi.fn(async () => null),
  saveStateSnapshot: vi.fn(async () => {}),
  removeStateSnapshot: vi.fn(async () => {}),
  getSubmittedBlocks: vi.fn(async () => null),
  saveSubmittedBlocks: vi.fn(async () => {}),
  removeSubmittedBlocks: vi.fn(async () => {}),
  getWorldOverlay: vi.fn(async () => null),
  saveWorldOverlay: vi.fn(async () => {}),
  migrateLocalStorageToIdb: vi.fn(async () => {}),
}));

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
  api.syncMessages.mockResolvedValue(undefined);
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
});
