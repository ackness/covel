import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserVault } from "../storage/browser-vault.js";
import { ApiError } from "../api/request.js";
import { createSessionWorkspace } from "../data-service/workspace.js";

const api = vi.hoisted(() => ({
  getWorld: vi.fn(),
  updateWorld: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  uploadBrowserCheckpoint: vi.fn(),
  fetchBrowserCommit: vi.fn(),
}));
vi.mock("../api.js", () => api);
const { LocalDataService } = await import("../data-service/local.js");
let vault: BrowserVault;

beforeEach(async () => {
  vi.resetAllMocks();
  vault = new BrowserVault({
    dbName: `workspace-recovery-${crypto.randomUUID()}`,
  });
  await vault.upsertWorld({
    id: "world",
    name: "World",
    description: "",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  api.getWorld.mockResolvedValue({ id: "world" });
  api.updateWorld.mockResolvedValue({ id: "world" });
  api.getSession.mockResolvedValue({ id: "session" });
  api.createSession.mockResolvedValue({
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
  });
  api.uploadBrowserCheckpoint.mockResolvedValue({ ok: true });
  api.fetchBrowserCommit.mockImplementation(
    async (_id: string, actionId: string, baseRevision: number) => ({
      baseRevision,
      revision: baseRevision + 1,
      actionId,
      checkpoint: {
        ...(await vault.getLatestCheckpoint("session")),
        revision: baseRevision + 1,
        actionId,
      },
    }),
  );
});
afterEach(async () => {
  await vault.deleteDatabase();
});

async function failedDownload() {
  const service = new LocalDataService(vault);
  await service.createSession("world", undefined, "session", [], "en-US");
  await service.addMessage({
    id: "durable-input",
    sessionId: "session",
    role: "user",
    content: "Keep this input",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  const workspace = createSessionWorkspace(service, "local");
  api.fetchBrowserCommit.mockRejectedValueOnce(
    new ApiError(503, "/browser-commit", ""),
  );
  await expect(
    workspace.run("session", "pending-action", async () => {}),
  ).rejects.toThrow();
  expect(await vault.getPendingCommit("session")).toBe("pending-action");
  return workspace;
}

describe("workspace durable pending-commit recovery", () => {
  it("rebuilds a restarted server with the same workspace instance", async () => {
    const workspace = await failedDownload();
    const checkpoint = await vault.getLatestCheckpoint("session");
    api.fetchBrowserCommit.mockRejectedValueOnce(
      new ApiError(404, "/browser-commit", ""),
    );
    api.getSession.mockRejectedValueOnce(
      new ApiError(404, "/sessions/session", ""),
    );
    await workspace.hydrate("session");
    expect(api.createSession).toHaveBeenCalledOnce();
    expect(api.uploadBrowserCheckpoint).toHaveBeenLastCalledWith(
      "session",
      checkpoint,
    );
    expect(await vault.getPendingCommit("session")).toBeNull();
    expect((await vault.getLatestCheckpoint("session"))?.messages).toHaveLength(
      1,
    );
  });

  it("downloads a previous pending result before staging a background commit after reload", async () => {
    await failedDownload();
    const before = (await vault.getLatestCheckpoint("session"))!.revision;
    const reloaded = createSessionWorkspace(
      new LocalDataService(vault),
      "local",
    );
    await reloaded.checkpoint("session", "background-action");
    expect(
      api.fetchBrowserCommit.mock.calls.slice(1).map((call) => call.slice(1)),
    ).toEqual([
      ["pending-action", before],
      ["background-action", before + 1],
    ]);
    expect(await vault.getPendingCommit("session")).toBeNull();
    expect((await vault.getLatestCheckpoint("session"))?.revision).toBe(
      before + 2,
    );
  });

  it.each([401, 409, 503])(
    "preserves the pending action on HTTP %i",
    async (status) => {
      const workspace = await failedDownload();
      const checkpoint = await vault.getLatestCheckpoint("session");
      api.fetchBrowserCommit.mockRejectedValue(
        new ApiError(status, "/browser-commit", ""),
      );
      await expect(workspace.hydrate("session")).rejects.toThrow();
      await expect(
        workspace.checkpoint("session", "background-action"),
      ).rejects.toThrow();
      expect(await vault.getPendingCommit("session")).toBe("pending-action");
      expect(await vault.getLatestCheckpoint("session")).toEqual(checkpoint);
      expect(api.uploadBrowserCheckpoint).toHaveBeenCalledTimes(1);
    },
  );
});
