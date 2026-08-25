import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserVault } from "../storage/browser-vault.js";

const api = vi.hoisted(() => ({
  getWorld: vi.fn(),
  createWorld: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  uploadBrowserCheckpoint: vi.fn(),
  fetchBrowserCommit: vi.fn(),
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
  saveExecutionSteps: vi.fn(async () => {}),
  getExecutionSteps: vi.fn(async () => []),
}));

vi.mock("../api.js", () => api);
vi.mock("../api/request.js", () => ({ isNotFound: () => true }));
vi.mock("../app-kv-store.js", () => appKv);

const { LocalDataService } = await import("../data-service/local.js");

let vault: BrowserVault;
let sequence = 0;

async function serviceWithWorld(
  worldId = "world-1",
): Promise<InstanceType<typeof LocalDataService>> {
  vault = new BrowserVault({ dbName: `local-session-sync-${++sequence}` });
  await vault.upsertWorld({
    id: worldId,
    name: "World",
    description: "",
    createdAt: new Date().toISOString(),
  });
  return new LocalDataService(vault);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getWorld.mockResolvedValue({ id: "world-1" });
  api.getSession.mockRejectedValue(new Error("404"));
  api.createSession.mockResolvedValue({ id: "sess-1" });
  api.deleteSession.mockResolvedValue(undefined);
  api.uploadBrowserCheckpoint.mockResolvedValue({ ok: true, revision: 1 });
  appKv.getStateSnapshot.mockResolvedValue(null);
});

afterEach(async () => {
  await vault?.deleteDatabase();
});

describe("LocalDataService browser-authoritative sync", () => {
  it("persists the selected plugin set, locale, and requested id", async () => {
    const service = await serviceWithWorld();
    const session = await service.createSession(
      "world-1",
      "preset-1",
      "session-explicit",
      ["pregame", "world-init", "scene-stage"],
      "en-US",
    );

    expect(session).toMatchObject({
      id: "session-explicit",
      activePlugins: ["pregame", "world-init", "scene-stage"],
      locale: "en-US",
    });
    await expect(service.getSession(session.id)).resolves.toMatchObject({
      activePlugins: ["pregame", "world-init", "scene-stage"],
      locale: "en-US",
    });
  });

  it("creates and hydrates the transient server mirror", async () => {
    const service = await serviceWithWorld();
    await service.createSession(
      "world-1",
      "preset-1",
      "sess-1",
      ["pregame", "world-init", "scene-stage"],
      "en-US",
    );

    await service.syncToServer("sess-1");

    expect(api.createSession).toHaveBeenCalledWith(
      "world-1",
      "preset-1",
      "sess-1",
      ["pregame", "world-init", "scene-stage"],
      "en-US",
    );
    expect(api.uploadBrowserCheckpoint).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        sessionId: "sess-1",
        profile: "browser-private",
        revision: 1,
      }),
    );
  });

  it("preserves underscore ids across the checkpoint boundary", async () => {
    const service = await serviceWithWorld("world_underscore");
    await service.createSession(
      "world_underscore",
      undefined,
      "session_underscore",
      [],
      "en-US",
    );

    await service.syncToServer("session_underscore");

    expect(api.getWorld).toHaveBeenCalledWith("world_underscore");
    expect(api.getSession).toHaveBeenCalledWith("session_underscore");
    expect(api.uploadBrowserCheckpoint).toHaveBeenCalledWith(
      "session_underscore",
      expect.objectContaining({ sessionId: "session_underscore" }),
    );
  });

  it("keeps UI snapshots in the browser-only KV channel", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");
    appKv.getStateSnapshot.mockResolvedValueOnce({ state: { hp: 100 } });

    await service.syncToServer("sess-1");

    expect(appKv.getStateSnapshot).not.toHaveBeenCalled();
    await expect(service.loadStateSnapshot("sess-1")).resolves.toEqual({
      state: { hp: 100 },
    });
  });

  it("deletes both the local authority and transient mirror", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");

    await service.deleteSession("sess-1");

    await expect(vault.getLatestCheckpoint("sess-1")).resolves.toBeNull();
    expect(api.deleteSession).toHaveBeenCalledWith("sess-1");
  });

  it("serializes concurrent server commits against the latest browser revision", async () => {
    const service = await serviceWithWorld();
    await service.createSession("world-1", undefined, "sess-1", [], "en-US");
    api.fetchBrowserCommit.mockImplementation(
      async (_sessionId: string, actionId: string, baseRevision: number) => {
        const current = await vault.getLatestCheckpoint("sess-1");
        if (!current) throw new Error("missing checkpoint");
        return {
          baseRevision,
          revision: baseRevision + 1,
          actionId,
          checkpoint: {
            ...current,
            revision: baseRevision + 1,
            actionId,
            committedAt: new Date().toISOString(),
          },
        };
      },
    );

    await Promise.all([
      service.commitFromServer("sess-1", "background-a"),
      service.commitFromServer("sess-1", "turn-b"),
    ]);

    expect(api.fetchBrowserCommit.mock.calls.map((call) => call[2])).toEqual([
      1, 2,
    ]);
    await expect(vault.getLatestCheckpoint("sess-1")).resolves.toMatchObject({
      revision: 3,
      actionId: "turn-b",
    });
  });
});
