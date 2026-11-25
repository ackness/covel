import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserVault } from "../storage/browser-vault.js";
import { LocalDataService } from "../data-service/local.js";
import type { WorldRecord } from "../api.js";
import { ApiError } from "../api/request.js";
import { summarizeWorld } from "@covel/shared";
import i18n from "@/i18n";
import { worldStorageLabel } from "@/components/session/world-select-screen.js";

const api = vi.hoisted(() => ({
  listWorlds: vi.fn(),
  getWorld: vi.fn(),
  deleteSession: vi.fn(),
}));
vi.mock("../api.js", () => api);

const catalog: WorldRecord[] = [
  {
    id: "haruka-academy",
    name: { "en-US": "Harukaze Academy", "zh-CN": "Fixture Academy" },
    description: "A complete catalog world",
    lore: "A twenty-one-day festival countdown",
    tags: ["school", "ensemble"],
    locale: "en-US",
    dimensions: {
      history: { name: "History", schema: { type: "array" }, initialValue: [] },
    },
    metadata: {
      source: "file",
      packageManaged: true,
      worldDataPath: "data/world.data.yaml",
      pluginSettings: { fixture: { enabled: true } },
      embeddedCharacters: [{ id: "fixture-npc", name: "Fixture NPC" }],
      storage: { scope: "server", backend: "file", durable: true },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "last-train",
    name: "Last Train Out",
    description: "Another catalog world",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

let dbName: string;
let vault: BrowserVault;
let secondVault: BrowserVault;

beforeEach(() => {
  // The catalog list carries summaries; the first visit reads each full record.
  api.listWorlds
    .mockReset()
    .mockResolvedValue(
      structuredClone(catalog).map((world) => summarizeWorld(world)),
    );
  api.getWorld
    .mockReset()
    .mockImplementation(async (id: string) =>
      structuredClone(catalog.find((world) => world.id === id)),
    );
  api.deleteSession.mockReset().mockResolvedValue(undefined);
  dbName = `local-initialization-${crypto.randomUUID()}`;
  vault = new BrowserVault({ dbName });
  secondVault = new BrowserVault({ dbName });
});

afterEach(async () => {
  vi.restoreAllMocks();
  secondVault.close();
  await vault.deleteDatabase();
});

it("imports the actual catalog with stable IDs and full package content into browser storage", async () => {
  await i18n.changeLanguage("en-US");
  const service = new LocalDataService(vault);
  const worlds = await service.listWorlds();
  expect(worlds.map((world) => world.id).sort()).toEqual([
    "haruka-academy",
    "last-train",
  ]);
  // The list is summaries; the vault and `getWorld` hold the full record.
  expect(
    worlds.find((world) => world.id === "haruka-academy"),
  ).not.toHaveProperty("lore");
  const academy = await service.getWorld("haruka-academy");
  expect(academy).toEqual({
    ...catalog[0],
    metadata: {
      ...catalog[0]!.metadata,
      storage: { scope: "browser", backend: "indexeddb", durable: true },
    },
    updatedAt: undefined,
  });
  expect(worldStorageLabel(academy!)).toBe("Browser IndexedDB");
  expect(await vault.getWorldInitialization()).toBeDefined();
});

it("leaves out a world deleted between the catalog list and its read", async () => {
  const gone = catalog[0]!.id;
  api.getWorld.mockImplementation(async (id: string) => {
    if (id === gone) {
      throw new ApiError(
        404,
        `/api/worlds/${id}`,
        '{"error":"World not found"}',
      );
    }
    return structuredClone(catalog.find((world) => world.id === id));
  });
  const worlds = await new LocalDataService(vault).listWorlds();
  expect(worlds.map((world) => world.id)).not.toContain(gone);
  expect(worlds).toHaveLength(catalog.length - 1);
});

it("skips browser execution mirrors in both catalog summaries and full records", async () => {
  const summaryMirror = {
    ...catalog[0]!,
    id: "mirror-in-list",
    metadata: {
      ...catalog[0]!.metadata,
      storage: { scope: "browser", backend: "indexeddb", durable: true },
    },
  };
  const replacedWorld = { ...catalog[1]!, id: "mirror-after-list" };
  api.listWorlds.mockResolvedValue(
    [...catalog, summaryMirror, replacedWorld].map(summarizeWorld),
  );
  const readCatalogWorld = api.getWorld.getMockImplementation()!;
  api.getWorld.mockImplementation((id: string) =>
    id === replacedWorld.id
      ? Promise.resolve({
          ...replacedWorld,
          metadata: { source: "browser-indexeddb" },
        })
      : readCatalogWorld(id),
  );

  const service = new LocalDataService(vault);
  expect((await service.listWorlds()).map(({ id }) => id).sort()).toEqual(
    catalog.map(({ id }) => id).sort(),
  );
  expect(api.getWorld).not.toHaveBeenCalledWith(summaryMirror.id, undefined);
});

it("still fails the first visit when a world read fails for another reason", async () => {
  api.getWorld.mockRejectedValue(new ApiError(500, "/api/worlds/x", "boom"));
  await expect(new LocalDataService(vault).listWorlds()).rejects.toThrow();
  expect(await vault.listWorlds()).toEqual([]);
});

it("retries a failed first catalog load without initializing an empty library", async () => {
  const service = new LocalDataService(vault);
  api.listWorlds.mockRejectedValueOnce(new Error("catalog unavailable"));
  await expect(service.listWorlds()).rejects.toThrow("catalog unavailable");
  expect(await vault.getWorldInitialization()).toBeUndefined();
  expect(await vault.listWorlds()).toEqual([]);
  expect(await service.listWorlds()).toHaveLength(catalog.length);
  expect(api.listWorlds).toHaveBeenCalledTimes(2);
});

it("keeps an initialized, edited library available offline", async () => {
  const service = new LocalDataService(vault);
  await service.listWorlds();
  await service.updateWorld("haruka-academy", { name: "Personal edit" });
  api.listWorlds.mockRejectedValueOnce(new Error("offline"));
  const reloaded = new LocalDataService(secondVault);
  expect((await reloaded.getWorld("haruka-academy"))?.name).toBe(
    "Personal edit",
  );
  expect(await reloaded.listWorlds()).toHaveLength(catalog.length);
  expect(api.listWorlds).toHaveBeenCalledTimes(2);
});

it("adds a new catalog world to an existing library without replacing edits or restoring deletions", async () => {
  const service = new LocalDataService(vault);
  await service.listWorlds();
  await service.updateWorld("haruka-academy", { name: "Personal edit" });
  await service.deleteWorld("last-train");
  const newWorld = { ...catalog[1]!, id: "new-world" };
  api.listWorlds.mockResolvedValue([...catalog, newWorld].map(summarizeWorld));
  api.getWorld.mockResolvedValueOnce(newWorld);
  api.getWorld.mockClear();

  const worlds = await new LocalDataService(secondVault).listWorlds();
  expect(worlds.map(({ id }) => id).sort()).toEqual([
    "haruka-academy",
    "new-world",
  ]);
  expect(worlds.find(({ id }) => id === "haruka-academy")?.name).toBe(
    "Personal edit",
  );
  expect(api.getWorld).toHaveBeenCalledExactlyOnceWith(
    "new-world",
    expect.anything(),
  );
});

it.each([false, true])(
  "adds worlds to a library initialized before catalog IDs were recorded (empty: %s)",
  async (empty) => {
    const service = new LocalDataService(vault);
    const initial = await service.listWorlds();
    if (empty) {
      for (const { id } of initial) await service.deleteWorld(id);
    }
    const legacy = await new Dexie(dbName).open();
    try {
      await legacy.table("initialization").put({ key: "worlds" });
    } finally {
      legacy.close();
    }
    const replacement = { ...catalog[1]!, id: "replacement-world" };
    api.listWorlds.mockResolvedValue([summarizeWorld(replacement)]);
    api.getWorld.mockResolvedValueOnce(replacement);

    const worlds = await new LocalDataService(secondVault).listWorlds();
    expect(worlds.map(({ id }) => id).sort()).toEqual(
      empty
        ? ["replacement-world"]
        : ["haruka-academy", "last-train", "replacement-world"],
    );
  },
);

it("accepts a successfully loaded empty catalog without inventing starter worlds", async () => {
  api.listWorlds.mockResolvedValue([]);
  expect(await new LocalDataService(vault).listWorlds()).toEqual([]);
  expect(await vault.getWorldInitialization()).toBeDefined();
});

it("initializes only one complete catalog snapshot across concurrent services", async () => {
  await Promise.all([
    new LocalDataService(vault).listWorlds(),
    new LocalDataService(secondVault).listWorlds(),
  ]);
  const worlds = await vault.listWorlds();
  expect(worlds).toHaveLength(catalog.length);
  expect(new Set(worlds.map((world) => JSON.stringify(world.name))).size).toBe(
    catalog.length,
  );
});

it("keeps an intentionally empty world library empty after reload", async () => {
  const service = new LocalDataService(vault);
  const worlds = await service.listWorlds();
  for (const world of worlds) await service.deleteWorld(world.id);
  expect(await new LocalDataService(secondVault).listWorlds()).toEqual([]);
  expect(api.getWorld).toHaveBeenCalledTimes(catalog.length);
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
  expect(await service.listWorlds()).toHaveLength(catalog.length);
});

it("does not import catalog worlds alongside existing user worlds", async () => {
  await vault.upsertWorld({
    id: "user-world",
    name: "User world",
    description: "",
    createdAt: "2026-01-01",
  });
  expect(
    (await new LocalDataService(vault).listWorlds()).map((world) => world.id),
  ).toEqual(["user-world"]);
  expect(api.listWorlds).not.toHaveBeenCalled();
});

it("allows fresh initialization after an explicit full vault reset", async () => {
  await new LocalDataService(vault).listWorlds();
  await vault.clear();
  expect(await new LocalDataService(secondVault).listWorlds()).toHaveLength(
    catalog.length,
  );
});

it("reimports the current catalog after deleting the vault and closes old tab connections", async () => {
  await new LocalDataService(secondVault).listWorlds();
  const replacement = { ...catalog[1]!, id: "replacement-world" };
  api.listWorlds.mockResolvedValue([summarizeWorld(replacement)]);
  api.getWorld.mockResolvedValueOnce(replacement);
  await new BrowserVault({ dbName }).deleteDatabase();

  await expect(secondVault.listWorlds()).rejects.toMatchObject({
    name: "DatabaseClosedError",
  });
  expect(
    (await new LocalDataService(vault).listWorlds()).map(({ id }) => id),
  ).toEqual(["replacement-world"]);
});

it("awaits catalog initialization before locking during updateWorld and deleteWorld", async () => {
  const order: string[] = [];
  api.listWorlds.mockImplementationOnce(async () => {
    order.push("listWorlds:start");
    await Promise.resolve();
    order.push("listWorlds:end");
    return catalog.map(summarizeWorld);
  });
  const lockSpy = vi
    .spyOn(vault, "withWorldLock")
    .mockImplementation(async function (this: BrowserVault, id, mode, fn) {
      order.push(`lock:${id}`);
      return BrowserVault.prototype.withWorldLock.call(this, id, mode, fn);
    });

  const updated = await new LocalDataService(vault).updateWorld("last-train", {
    description: "Updated directly before listing",
  });
  expect(updated.description).toBe("Updated directly before listing");
  expect(order).toEqual([
    "listWorlds:start",
    "listWorlds:end",
    "lock:last-train",
  ]);
  lockSpy.mockRestore();

  await vault.clear();
  const deleteOrder: string[] = [];
  api.listWorlds.mockImplementationOnce(async () => {
    deleteOrder.push("listWorlds:start");
    await Promise.resolve();
    deleteOrder.push("listWorlds:end");
    return catalog.map(summarizeWorld);
  });
  const deleteLockSpy = vi
    .spyOn(secondVault, "withWorldLock")
    .mockImplementation(async function (this: BrowserVault, id, mode, fn) {
      deleteOrder.push(`lock:${id}`);
      return BrowserVault.prototype.withWorldLock.call(this, id, mode, fn);
    });

  await new LocalDataService(secondVault).deleteWorld("haruka-academy");
  expect(await vault.getWorld("haruka-academy")).toBeNull();
  expect(deleteOrder).toEqual([
    "listWorlds:start",
    "listWorlds:end",
    "lock:haruka-academy",
  ]);
  deleteLockSpy.mockRestore();
});
