import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserVault } from "../storage/browser-vault.js";

const api = vi.hoisted(() => ({
  listWorlds: vi.fn(async () => []),
  getWorld: vi.fn(),
}));

const appKv = vi.hoisted(() => ({
  clearBrowserGameCache: vi.fn(async () => {}),
}));

const credentials = vi.hoisted(() => ({
  listSessionCredentials: vi.fn(async () => []),
  clearSessionToken: vi.fn(async () => {}),
}));

vi.mock("../api.js", () => api);
vi.mock("../app-kv-store.js", () => appKv);
vi.mock("../session-credentials.js", () => credentials);

const { getDataService, getSessionWorkspace, setStorageMode } =
  await import("../data-service.js");
const { resetBrowserGameData } = await import("../data-service/local.js");

describe("resetBrowserGameData singleton cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listWorlds.mockResolvedValue([]);
    setStorageMode("local");
  });

  afterEach(async () => {
    await new BrowserVault().deleteDatabase();
    setStorageMode("remote");
  });

  it("invalidates the cached LocalDataService and workspace singletons so post-reset calls use a fresh DB connection", async () => {
    const firstService = getDataService();
    const firstWorkspace = getSessionWorkspace();

    await firstService.createWorld("Ephemeral World", "Will be wiped");
    expect(await firstService.listWorlds()).toHaveLength(1);
    expect(api.listWorlds).toHaveBeenCalledTimes(1);

    const onBlocked = vi.fn();
    await resetBrowserGameData(onBlocked);
    expect(onBlocked).not.toHaveBeenCalled();

    const secondService = getDataService();
    const secondWorkspace = getSessionWorkspace();
    expect(secondService).not.toBe(firstService);
    expect(secondWorkspace).not.toBe(firstWorkspace);

    // Subsequent reads use a healthy new connection and re-run catalog init.
    await expect(secondService.listWorlds()).resolves.toEqual([]);
    expect(api.listWorlds).toHaveBeenCalledTimes(2);
    await expect(
      secondService.createWorld("Fresh World", "Created after reset"),
    ).resolves.toMatchObject({ name: "Fresh World" });
  });
});
