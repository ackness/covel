import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserVault } from "../storage/browser-vault.js";
import { LocalDataService } from "../data-service/local.js";
import { LOCAL_SEED_WORLDS } from "../data-service/seed-worlds.js";

vi.mock("../api.js", () => ({ deleteSession: vi.fn() }));

let dbName: string;
let vault: BrowserVault;
let secondVault: BrowserVault;

beforeEach(() => {
  dbName = `local-initialization-${crypto.randomUUID()}`;
  vault = new BrowserVault({ dbName });
  secondVault = new BrowserVault({ dbName });
});

afterEach(async () => {
  vi.restoreAllMocks();
  secondVault.close();
  await vault.deleteDatabase();
});

it("initializes only one complete seed set across concurrent services", async () => {
  await Promise.all([
    new LocalDataService(vault).listWorlds(),
    new LocalDataService(secondVault).listWorlds(),
  ]);
  const worlds = await vault.listWorlds();
  expect(worlds).toHaveLength(LOCAL_SEED_WORLDS.length);
  expect(new Set(worlds.map((world) => JSON.stringify(world.name))).size).toBe(
    LOCAL_SEED_WORLDS.length,
  );
});

it("keeps an intentionally empty world library empty after reload", async () => {
  const service = new LocalDataService(vault);
  const worlds = await service.listWorlds();
  for (const world of worlds) await service.deleteWorld(world.id);
  expect(await new LocalDataService(secondVault).listWorlds()).toEqual([]);
});

it("rolls back partial seeding and permits retry on the same service", async () => {
  const service = new LocalDataService(vault);
  const put = IDBObjectStore.prototype.put;
  let writes = 0;
  const failing = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "worlds" && ++writes === 2) {
        throw new DOMException(
          "Synthetic storage failure",
          "QuotaExceededError",
        );
      }
      return put.call(this, value, key);
    });
  await expect(service.listWorlds()).rejects.toThrow(
    "Synthetic storage failure",
  );
  failing.mockRestore();
  expect(await vault.listWorlds()).toEqual([]);
  expect(await service.listWorlds()).toHaveLength(LOCAL_SEED_WORLDS.length);
});

it("does not add seeds alongside existing user worlds", async () => {
  await vault.upsertWorld({
    id: "user-world",
    name: "User world",
    description: "",
    createdAt: "2026-01-01",
  });
  expect(
    (await new LocalDataService(vault).listWorlds()).map((world) => world.id),
  ).toEqual(["user-world"]);
});

it("allows fresh initialization after an explicit full vault reset", async () => {
  await new LocalDataService(vault).listWorlds();
  await vault.clear();
  expect(await new LocalDataService(secondVault).listWorlds()).toHaveLength(
    LOCAL_SEED_WORLDS.length,
  );
});

it.each([false, true])(
  "preserves a pre-existing v4 library on upgrade (has worlds: %s)",
  async (hasWorlds) => {
    const old = new Dexie(dbName);
    old.version(4).stores({
      checkpoints: "sessionId, revision, committedAt",
      commits: "id, sessionId, actionId, revision, [sessionId+actionId]",
      pendingCommits: "sessionId, actionId, stagedAt",
      worlds: "id, createdAt, updatedAt",
    });
    try {
      await old.open();
      if (hasWorlds)
        await old.table("worlds").put({
          id: "existing-world",
          name: "Existing",
          description: "",
          createdAt: "2026-01-01",
        });
    } finally {
      old.close();
    }
    expect(
      (await new LocalDataService(vault).listWorlds()).map((world) => world.id),
    ).toEqual(hasWorlds ? ["existing-world"] : []);
  },
);
