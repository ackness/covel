import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserVault } from "../storage/browser-vault.js";
import { LocalDataService } from "../data-service/local.js";

const api = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  deleteWorld: vi.fn(),
}));
vi.mock("../api.js", () => api);
vi.mock("../app-kv-store.js", () => ({
  removeStatePatches: async () => {},
  removeSubmittedBlocks: async () => {},
  removeExecutionSteps: async () => {},
}));
let vault: BrowserVault;
let service: LocalDataService;
beforeEach(async () => {
  vi.clearAllMocks();
  vault = new BrowserVault({
    dbName: `world-lifecycle-${crypto.randomUUID()}`,
  });
  await vault.upsertWorld({
    id: "world-a",
    name: "World A",
    description: "",
    createdAt: "2026-01-01",
  });
  await vault.upsertWorld({
    id: "world-b",
    name: "World B",
    description: "",
    createdAt: "2026-01-01",
  });
  service = new LocalDataService(vault);
  api.deleteSession.mockResolvedValue(undefined);
});
afterEach(async () => {
  await vault.deleteDatabase();
});

it("keeps edited worlds through later local checkpoint writes and a fresh service", async () => {
  await service.createSession("world-a", undefined, "session-a");
  await service.updateWorld("world-a", {
    dimensions: { history: [] },
    name: "Edited",
  });
  await service.addMessage({
    id: "message-a",
    sessionId: "session-a",
    role: "user",
    content: "Hello",
    createdAt: "2026-01-02",
  });
  await service.updateSession("session-a", { status: "paused" });
  const reloaded = new LocalDataService(vault);
  expect((await reloaded.getWorld("world-a"))?.name).toBe("Edited");
  expect((await vault.getCheckpoint("session-a"))?.world?.name).toBe("Edited");
});

it("atomically deletes a world and its local sessions without deleting shared server worlds", async () => {
  await service.createSession("world-a", undefined, "session-a");
  await service.createSession("world-a", undefined, "session-a2");
  await service.createSession("world-b", undefined, "session-b");
  await service.updateSession("session-a", { status: "paused" });
  await vault.stagePendingCommit("session-a", "pending-a");
  api.deleteSession.mockRejectedValue(new Error("offline"));
  await service.deleteWorld("world-a");
  const reloaded = new LocalDataService(vault);
  expect((await reloaded.listWorlds()).map((world) => world.id)).toEqual([
    "world-b",
  ]);
  expect(await reloaded.getSession("session-a")).toBeNull();
  expect(await reloaded.getSession("session-a2")).toBeNull();
  expect(await vault.getPendingCommit("session-a")).toBeNull();
  expect(await reloaded.getSession("session-b")).not.toBeNull();
  expect(api.deleteSession.mock.calls.map(([id]) => id).sort()).toEqual([
    "session-a",
    "session-a2",
  ]);
  expect(api.deleteWorld).not.toHaveBeenCalled();
});

it("rejects invalid edited dimensions before they can break session checkpoints", async () => {
  await expect(
    service.updateWorld("world-a", {
      dimensions: { geography: { regions: [] } },
    }),
  ).rejects.toThrow();
  expect((await service.getWorld("world-a"))?.dimensions).toBeUndefined();
});
