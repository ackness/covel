import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMemoryStore,
  type DataStore,
  type WorldRecord,
} from "@covel/store";
import {
  seedWorlds,
  reconcileSeededWorlds,
} from "../../src/world-seed-loader.js";

const NOW = "2026-06-29T00:00:00.000Z";

async function addWorld(
  store: DataStore,
  id: string,
  source: string,
): Promise<void> {
  const record: WorldRecord = {
    id,
    name: id,
    description: "",
    createdAt: NOW,
    updatedAt: NOW,
    metadata: { source },
  };
  await store.upsertWorld(record);
}

async function addSession(
  store: DataStore,
  id: string,
  worldId: string,
): Promise<void> {
  await store.createSession({
    id,
    worldId,
    status: "active",
    turnCount: 0,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function listWorldIds(store: DataStore): Promise<string[]> {
  return (await store.listWorlds()).map((w) => w.id).sort();
}

describe("reconcileSeededWorlds", () => {
  it("removes a file-seeded world that is gone from every package and has no sessions", async () => {
    const store = createMemoryStore();
    await addWorld(store, "mistport", "file");
    await addWorld(store, "cloudmere", "file"); // archived, no sessions

    const result = await reconcileSeededWorlds(
      store,
      new Set(["mistport"]), // cloudmere no longer seeded
    );

    expect(result.removed).toEqual(["cloudmere"]);
    expect(result.keptWithSessions).toEqual([]);
    expect(await listWorldIds(store)).toEqual(["mistport"]);
  });

  it("keeps worlds that are still present in the live set", async () => {
    const store = createMemoryStore();
    await addWorld(store, "mistport", "file");
    await addWorld(store, "haruka-academy", "file");

    const result = await reconcileSeededWorlds(
      store,
      new Set(["mistport", "haruka-academy"]),
    );

    expect(result.removed).toEqual([]);
    expect(await listWorldIds(store)).toEqual(["haruka-academy", "mistport"]);
  });

  it("never touches AI-generated worlds even when absent from the live set", async () => {
    const store = createMemoryStore();
    await addWorld(store, "mistport", "file");
    await addWorld(store, "my-generated", "generated"); // DB-only, no files
    await addWorld(store, "saved-gen", "generated-file"); // file removed by user

    const result = await reconcileSeededWorlds(store, new Set(["mistport"]));

    expect(result.removed).toEqual([]);
    expect(await listWorldIds(store)).toEqual([
      "mistport",
      "my-generated",
      "saved-gen",
    ]);
  });

  it("keeps a stale world that still has saved sessions instead of deleting saves", async () => {
    const store = createMemoryStore();
    await addWorld(store, "mistport", "file");
    await addWorld(store, "cloudmere", "file");
    await addSession(store, "sess-1", "cloudmere"); // player has a save here

    const result = await reconcileSeededWorlds(store, new Set(["mistport"]));

    expect(result.removed).toEqual([]);
    expect(result.keptWithSessions).toEqual(["cloudmere"]);
    expect(await listWorldIds(store)).toEqual(["cloudmere", "mistport"]);
  });
});

describe("seedWorlds", () => {
  it("returns the ids of the worlds it loaded (so callers can build the live set)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "covel-reconcile-"));
    const make = async (id: string) => {
      const dir = path.join(root, id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "world.yaml"),
        `schemaVersion: "1.0"
id: ${id}
name: ${id}
summary: seed test
defaultLocale: zh-CN
supportedLocales: [zh-CN]
`,
      );
      await writeFile(path.join(dir, "WORLD.md"), `# ${id}`);
    };
    await make("alpha");
    await make("beta");

    const store = createMemoryStore();
    const ids = await seedWorlds(store, root);

    expect([...ids].sort()).toEqual(["alpha", "beta"]);
  });
});
