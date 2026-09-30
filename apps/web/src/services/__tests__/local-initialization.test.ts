import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserVault } from "../storage/browser-vault.js";
import { LocalDataService } from "../data-service/local.js";
import type { WorldRecord } from "../api.js";
import i18n from "@/i18n";
import { worldStorageLabel } from "@/components/session/world-select-screen.js";

const api = vi.hoisted(() => ({ listWorlds: vi.fn(), deleteSession: vi.fn() }));
vi.mock("../api.js", () => api);

const catalog: WorldRecord[] = [
  {
    id: "haruka-academy",
    name: { "en-US": "Haruka Academy", "zh-CN": "Fixture Academy" },
    description: "A complete catalog world",
    lore: "A twenty-one-day festival countdown",
    tags: ["school", "ensemble"],
    locale: "en-US",
    dimensions: { history: [] },
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
    id: "emberback",
    name: "Emberback",
    description: "Another catalog world",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

let dbName: string;
let vault: BrowserVault;
let secondVault: BrowserVault;

beforeEach(() => {
  api.listWorlds.mockReset().mockResolvedValue(structuredClone(catalog));
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
  const worlds = await new LocalDataService(vault).listWorlds();
  const academy = worlds.find((world) => world.id === "haruka-academy");
  expect(worlds.map((world) => world.id).sort()).toEqual([
    "emberback",
    "haruka-academy",
  ]);
  expect(academy).toEqual({
    ...catalog[0],
    metadata: {
      ...catalog[0].metadata,
      storage: { scope: "browser", backend: "indexeddb", durable: true },
    },
    updatedAt: undefined,
  });
  expect(worldStorageLabel(academy!)).toBe("Browser IndexedDB");
  expect(await vault.hasInitializedWorlds()).toBe(true);
});

it("retries a failed first catalog load without initializing an empty library", async () => {
  const service = new LocalDataService(vault);
  api.listWorlds.mockRejectedValueOnce(new Error("catalog unavailable"));
  await expect(service.listWorlds()).rejects.toThrow("catalog unavailable");
  expect(await vault.hasInitializedWorlds()).toBe(false);
  expect(await vault.listWorlds()).toEqual([]);
  expect(await service.listWorlds()).toHaveLength(catalog.length);
  expect(api.listWorlds).toHaveBeenCalledTimes(2);
});

it("keeps an initialized, edited library available offline and ignores later catalog updates", async () => {
  const service = new LocalDataService(vault);
  await service.listWorlds();
  await service.updateWorld("haruka-academy", { name: "Personal edit" });
  api.listWorlds.mockRejectedValue(new Error("offline"));
  const reloaded = new LocalDataService(secondVault);
  expect((await reloaded.getWorld("haruka-academy"))?.name).toBe(
    "Personal edit",
  );
  expect(await reloaded.listWorlds()).toHaveLength(catalog.length);
  expect(api.listWorlds).toHaveBeenCalledTimes(1);
});

it("accepts a successfully loaded empty catalog without inventing starter worlds", async () => {
  api.listWorlds.mockResolvedValue([]);
  expect(await new LocalDataService(vault).listWorlds()).toEqual([]);
  expect(await vault.hasInitializedWorlds()).toBe(true);
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
  api.listWorlds.mockRejectedValue(new Error("offline"));
  expect(await new LocalDataService(secondVault).listWorlds()).toEqual([]);
  expect(api.listWorlds).toHaveBeenCalledTimes(1);
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
