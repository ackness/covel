import { registerDimensionProvider } from "../helpers/dimension-provider.js";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { type DataStore, type MediaStore } from "@covel/store";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import { worldRoutes } from "../../src/routes/api/worlds.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";

type Env = {
  Variables: {
    store: DataStore;
    eventBus: ReturnType<typeof createEventBus>;
    pluginRegistry: PluginRegistry;
    mediaStore?: MediaStore;
    worldsDirs?: readonly string[];
    covelHome?: string;
    sessionLock: SessionLock;
  };
};

function createTestApp(
  store: DataStore,
  pluginRegistry: PluginRegistry,
  options: {
    mediaStore?: MediaStore;
    worldsDirs?: readonly string[];
    covelHome?: string;
  } = {},
): Hono<Env> {
  const eventBus = createEventBus();
  const sessionLock = createInProcessSessionLock();
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("eventBus", eventBus);
    c.set("pluginRegistry", pluginRegistry);
    c.set("sessionLock", sessionLock);
    if (options.mediaStore) c.set("mediaStore", options.mediaStore);
    if (options.worldsDirs) c.set("worldsDirs", options.worldsDirs);
    if (options.covelHome) c.set("covelHome", options.covelHome);
    await next();
  });
  app.route("/api/worlds", worldRoutes);
  return app;
}

function makeDimensions(regionName: string, factionName: string) {
  return {
    geography: {
      name: "geography",
      schema: {},
      initialValue: {
        regions: [
          {
            name: regionName,
            description: `${regionName} description`,
            climate: "temperate",
          },
        ],
      },
    },
    factions: {
      name: "factions",
      schema: {},
      initialValue: [
        {
          id: "guild",
          name: factionName,
          description: `${factionName} description`,
          type: "guild" as const,
          influence: "minor" as const,
        },
      ],
    },
  };
}

async function makeWorldDataFixture() {
  const worldsDir = await mkdtemp(path.join(tmpdir(), "covel-worlds-api-"));
  const worldRoot = path.join(worldsDir, "preflight-world");
  await mkdir(path.join(worldRoot, "data"), { recursive: true });
  await writeFile(
    path.join(worldRoot, "world.yaml"),
    `schemaVersion: "1"
id: preflight-world
name: Preflight World
summary: Preflight world
defaultLocale: zh-CN
worldData: data/world.data.yaml
`,
  );
  await writeFile(
    path.join(worldRoot, "data/world.data.yaml"),
    `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: contract:world.facts@1
    key: id
`,
  );
  await writeFile(
    path.join(worldRoot, "data/facts.json"),
    JSON.stringify([{ id: "one", content: "One fact." }]),
  );
  return { worldsDir };
}

async function makeMediaWorldDataFixture() {
  const worldsDir = await mkdtemp(path.join(tmpdir(), "covel-worlds-media-"));
  const worldRoot = path.join(worldsDir, "media-world");
  const descriptorPath = path.join(worldRoot, "data/world.data.yaml");
  await mkdir(path.join(worldRoot, "data"), { recursive: true });
  await mkdir(path.join(worldRoot, "media/portraits"), { recursive: true });
  await writeFile(
    path.join(worldRoot, "world.yaml"),
    `schemaVersion: "1"
id: media-world
name: Media World
summary: Media world
defaultLocale: zh-CN
worldData: data/world.data.yaml
`,
  );
  await writeFile(
    descriptorPath,
    `schemaVersion: 1
sources:
  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: contract:character.portrait-assets@1
    key: filename
`,
  );
  await writeFile(path.join(worldRoot, "media/portraits/mio.png"), "png-ish");
  return { worldsDir, descriptorPath };
}

describe("world routes", () => {
  let store: DataStore;
  let app: Hono<Env>;

  beforeEach(() => {
    store = createMemoryStore();
    const pluginRegistry = {
      get: () => undefined,
    } as PluginRegistry;
    app = createTestApp(store, pluginRegistry);
  });

  it("GET /api/worlds lists summaries and GET /api/worlds/:id returns the full record", async () => {
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "world-full",
      name: "Full",
      description: "Summary text",
      lore: "The long lore.",
      dimensions: makeDimensions("Reach", "Guild"),
      metadata: {
        source: "file",
        accentColor: "#336699",
        embeddedCharacters: [{ id: "c1", name: "C" }],
        localizedText: { name: { en: "Full" }, lore: { en: "Lore" } },
      },
      createdAt: now,
      updatedAt: now,
    });

    const listed = (await (await app.request("/api/worlds")).json()) as {
      items: Record<string, unknown>[];
    };
    const item = listed.items.find((world) => world.id === "world-full")!;
    expect(item).not.toHaveProperty("lore");
    expect(item).not.toHaveProperty("dimensions");
    expect(item.metadata).toEqual({
      source: "file",
      accentColor: "#336699",
      localizedText: { name: { en: "Full" } },
    });

    const full = (await (
      await app.request("/api/worlds/world-full")
    ).json()) as {
      lore: string;
      metadata: Record<string, unknown>;
    };
    expect(full.lore).toBe("The long lore.");
    expect(full.metadata.embeddedCharacters).toEqual([{ id: "c1", name: "C" }]);
  });

  it("POST /api/worlds mints an id when omitted", async () => {
    const res = await app.request("/api/worlds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Player World", description: "Created" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body).toMatchObject({ name: "Player World" });
    expect(body.id).toMatch(/^world-[a-f0-9]{8}$/);
    expect(await store.getWorld(body.id)).not.toBeNull();
  });

  it("POST /api/worlds does not overwrite an existing id", async () => {
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "world-1",
      name: "Original",
      description: "Keep me",
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request("/api/worlds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "world-1",
        name: "Replacement",
        description: "Overwrite",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "world_already_exists",
    });
    expect(await store.getWorld("world-1")).toMatchObject({
      name: "Original",
      description: "Keep me",
    });
  });

  it("PATCH /api/worlds/:id accepts top-level dimensions and preserves sibling metadata", async () => {
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "world-1",
      name: "World 1",
      description: "desc",
      metadata: {
        dimensions: makeDimensions("Old Reach", "Old Guild"),
        publishing: { status: "draft" },
      },
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request("/api/worlds/world-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dimensions: makeDimensions("New Reach", "Guild"),
      }),
    });

    expect(res.status).toBe(200);
    const world = await store.getWorld("world-1");
    const metadata = world?.metadata as Record<string, unknown>;
    expect(metadata.publishing).toEqual({ status: "draft" });
    expect(metadata.dimensions).toEqual(makeDimensions("New Reach", "Guild"));
    expect(world?.dimensions).toEqual(makeDimensions("New Reach", "Guild"));
    expect((await res.json()).dimensions).toEqual(
      makeDimensions("New Reach", "Guild"),
    );
  });

  it("DELETE /api/worlds/:id removes generated-file world packages", async () => {
    const worldsDir = await mkdtemp(path.join(tmpdir(), "covel-delete-world-"));
    const worldRoot = path.join(worldsDir, "generated-world");
    await mkdir(worldRoot, { recursive: true });
    await writeFile(
      path.join(worldRoot, "world.yaml"),
      "id: generated-world\n",
      "utf8",
    );
    app = createTestApp(store, {} as PluginRegistry, {
      worldsDirs: [worldsDir],
    });
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "generated-world",
      name: "Generated",
      description: "desc",
      metadata: {
        source: "generated-file",
        storage: { scope: "server", backend: "file", path: worldsDir },
      },
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request("/api/worlds/generated-world", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    await expect(access(worldRoot)).rejects.toThrow();
    expect(await store.getWorld("generated-world")).toBeNull();
  });

  it("DELETE /api/worlds/:id removes a world created through the API", async () => {
    const create = await app.request("/api/worlds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "player-world",
        name: "Player World",
        description: "Created from the world endpoint",
      }),
    });
    expect(create.status).toBe(201);

    const remove = await app.request("/api/worlds/player-world", {
      method: "DELETE",
    });

    expect(remove.status).toBe(200);
    expect(await store.getWorld("player-world")).toBeNull();
  });

  it("DELETE /api/worlds/:id rejects a built-in file world", async () => {
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "built-in-world",
      name: "Built-in",
      description: "Repository managed",
      metadata: { source: "file" },
      createdAt: now,
      updatedAt: now,
    });

    const patch = await app.request("/api/worlds/built-in-world", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Edited",
        metadata: { source: "generated", storage: { backend: "memory" } },
      }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).metadata).toEqual({ source: "file" });

    const remove = await app.request("/api/worlds/built-in-world", {
      method: "DELETE",
    });

    expect(remove.status).toBe(403);
    expect(await store.getWorld("built-in-world")).not.toBeNull();
  });

  it("sync-dimensions adopts protected records and never rewrites lorebook/plugin data", async () => {
    const now = new Date().toISOString();
    const registry = createPluginRegistry();
    await registerDimensionProvider(registry);
    app = createTestApp(store, registry);
    await store.upsertWorld({
      id: "world-2",
      name: "World 2",
      description: "",
      metadata: { dimensions: makeDimensions("North", "Guild") },
      createdAt: now,
    });
    await store.createSession({
      id: "sess-1",
      worldId: "world-2",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      metadata: { sessionIncarnationNonce: crypto.randomUUID() },
      completedPlayerTurns: 0,
      locale: "en-US",
      activePlugins: ["world-init"],
      createdAt: now,
      updatedAt: now,
    });
    await store.setPluginData({
      sessionId: "sess-1",
      pluginId: "opaque",
      namespace: "default",
      key: "counter",
      value: { n: 9 },
      updatedAt: now,
    });
    const sync = () =>
      app.request("/api/worlds/world-2/sync-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-1" }),
      });
    expect((await sync()).status).toBe(200);
    const imported = await store.getPluginData(
      "sess-1",
      "world-init",
      "_dimensions",
      "geography",
    );
    expect(imported?.value).toMatchObject({
      version: 1,
      value: { regions: [{ name: "North" }] },
    });
    expect(
      (await store.listWorldDataImportLedger("sess-1")).filter(
        (entry) => entry.namespace === "_dimensions",
      ),
    ).toHaveLength(2);
    const evolved = {
      ...(imported!.value as Record<string, unknown>),
      version: 2,
      value: { regions: [{ name: "Player correction" }] },
    };
    await store.compareAndSetPluginDataBatch("sess-1", "world-init", [
      {
        namespace: "_dimensions",
        key: "geography",
        expectedVersion: 1,
        value: evolved,
        timestamp: now,
      },
    ]);
    expect((await (await sync()).json()).conflicts).toEqual([]);
    await store.upsertWorld({
      id: "world-2",
      name: "World 2",
      description: "",
      metadata: { dimensions: makeDimensions("South", "Guild") },
      createdAt: now,
    });
    const conflicted = await (await sync()).json();
    expect(conflicted.conflicts).toEqual([
      {
        sourceId: "dimensions",
        target: "contract:world.dimensions@1",
        key: "geography",
        reason: "modified",
      },
    ]);
    expect(
      (
        await store.getPluginData(
          "sess-1",
          "world-init",
          "_dimensions",
          "geography",
        )
      )?.value,
    ).toEqual(evolved);
    expect(
      (await store.getPluginData("sess-1", "opaque", "default", "counter"))
        ?.value,
    ).toEqual({ n: 9 });
    expect(await store.listSessionLorebookEntries("sess-1")).toEqual([]);
  });

  it.each(["world-data/preflight", "sync-data", "sync-dimensions"])(
    "rejects null body for %s",
    async (suffix) => {
      const response = await app.request(`/api/worlds/test-world/${suffix}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      });
      expect(response.status).toBe(400);
    },
  );

  it("POST /api/worlds/:id/world-data/preflight reports a read-only import plan", async () => {
    const { worldsDir } = await makeWorldDataFixture();
    const pluginRegistry = {
      getAll() {
        return new Map(
          ["world-notes", "character-presence"].flatMap((id) => {
            const entry = this.get(id);
            return entry ? [[id, entry]] : [];
          }),
        );
      },
      get: (pluginId: string) =>
        pluginId === "world-notes"
          ? {
              id: "world-notes",
              packageManifest: {
                plugin: {
                  contributes: {
                    data: { facts: { version: 1, accepts: ["world.facts@1"] } },
                  },
                },
              },
              dataSchemas: {
                facts: {
                  namespace: "facts",
                  schemaVersion: 1,
                  acceptsWorldData: true,
                },
              },
            }
          : undefined,
    } as PluginRegistry;
    // Record every store call so the read-only claim covers any write the
    // route might make, whatever session id it used.
    const storeCalls: string[] = [];
    const recordingStore = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function" || typeof prop !== "string") {
          return value;
        }
        return (...args: unknown[]) => {
          storeCalls.push(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    app = createTestApp(recordingStore, pluginRegistry, {
      worldsDirs: [worldsDir],
    });

    const res = await app.request(
      "/api/worlds/preflight-world/world-data/preflight",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugins: ["world-notes"] }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      imported: boolean;
      planned: number;
      diagnostics: Array<{ level: string; message: string }>;
      targets: Array<{ target: string; pluginId?: string; namespace?: string }>;
    };
    expect(body.imported).toBe(true);
    expect(body.planned).toBe(1);
    expect(body.diagnostics.filter((item) => item.level === "error")).toEqual(
      [],
    );
    expect(body.targets).toMatchObject([
      {
        target: "contract:world.facts@1",
        pluginId: "world-notes",
        namespace: "facts",
      },
    ]);
    expect(storeCalls.length).toBeGreaterThan(0);
    expect(
      storeCalls.filter((name) => !/^(get|list|has|find)/.test(name)),
    ).toEqual([]);
    expect(await store.listSessions()).toEqual([]);
  });

  it("POST /api/worlds/:id/sync-data dry-runs and applies importer-managed updates", async () => {
    const { worldsDir } = await makeWorldDataFixture();
    const now = new Date().toISOString();
    const pluginRegistry = {
      getAll() {
        return new Map(
          ["world-notes", "character-presence"].flatMap((id) => {
            const entry = this.get(id);
            return entry ? [[id, entry]] : [];
          }),
        );
      },
      get: (pluginId: string) =>
        pluginId === "world-notes"
          ? {
              id: "world-notes",
              packageManifest: {
                plugin: {
                  contributes: {
                    data: { facts: { version: 1, accepts: ["world.facts@1"] } },
                  },
                },
              },
              dataSchemas: {
                facts: {
                  namespace: "facts",
                  schemaVersion: 1,
                  acceptsWorldData: true,
                },
              },
            }
          : undefined,
    } as PluginRegistry;
    app = createTestApp(store, pluginRegistry, { worldsDirs: [worldsDir] });
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "sync-session",
      worldId: "preflight-world",
      status: "active",
      completedPlayerTurns: 0,

      locale: "zh-CN",
      activePlugins: ["world-notes"],
      createdAt: now,
      updatedAt: now,
    });

    const dryRun = await app.request("/api/worlds/preflight-world/sync-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sync-session" }),
    });

    expect(dryRun.status).toBe(200);
    expect(await dryRun.json()).toMatchObject({
      dryRun: true,
      upserted: 1,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
    });
    expect(
      await store.listPluginData("sync-session", "world-notes", "facts"),
    ).toEqual([]);

    const apply = await app.request("/api/worlds/preflight-world/sync-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sync-session", dryRun: false }),
    });

    expect(apply.status).toBe(200);
    expect(await apply.json()).toMatchObject({
      dryRun: false,
      upserted: 1,
      deleted: 0,
      conflicts: [],
    });
    expect(
      await store.getPluginData("sync-session", "world-notes", "facts", "one"),
    ).toMatchObject({ value: { id: "one", content: "One fact." } });
  });

  it("POST /api/worlds/:id/sync-data reports modified managed rows as conflicts", async () => {
    const { worldsDir } = await makeWorldDataFixture();
    const now = new Date().toISOString();
    const pluginRegistry = {
      getAll() {
        return new Map(
          ["world-notes", "character-presence"].flatMap((id) => {
            const entry = this.get(id);
            return entry ? [[id, entry]] : [];
          }),
        );
      },
      get: (pluginId: string) =>
        pluginId === "world-notes"
          ? {
              id: "world-notes",
              packageManifest: {
                plugin: {
                  contributes: {
                    data: { facts: { version: 1, accepts: ["world.facts@1"] } },
                  },
                },
              },
              dataSchemas: {
                facts: {
                  namespace: "facts",
                  schemaVersion: 1,
                  acceptsWorldData: true,
                },
              },
            }
          : undefined,
    } as PluginRegistry;
    app = createTestApp(store, pluginRegistry, { worldsDirs: [worldsDir] });
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "sync-conflict",
      worldId: "preflight-world",
      status: "active",
      completedPlayerTurns: 0,

      locale: "zh-CN",
      activePlugins: ["world-notes"],
      createdAt: now,
      updatedAt: now,
    });
    await app.request("/api/worlds/preflight-world/sync-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sync-conflict", dryRun: false }),
    });
    await store.setPluginData({
      id: "manual-edit",
      sessionId: "sync-conflict",
      pluginId: "world-notes",
      namespace: "facts",
      key: "one",
      value: { id: "one", content: "Player edited." },
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request("/api/worlds/preflight-world/sync-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sync-conflict", dryRun: false }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      dryRun: false,
      upserted: 0,
      deleted: 0,
      conflicts: [
        {
          target: "contract:world.facts@1",
          key: "one",
          sourceId: "facts",
          reason: "modified",
        },
      ],
    });
    expect(
      await store.getPluginData("sync-conflict", "world-notes", "facts", "one"),
    ).toMatchObject({ value: { id: "one", content: "Player edited." } });
  });

  it("POST /api/worlds/:id/sync-data removes only the current session media ref for shared assets", async () => {
    const { worldsDir, descriptorPath } = await makeMediaWorldDataFixture();
    const now = new Date().toISOString();
    const mediaStore = createMemoryMediaStore();
    const pluginRegistry = {
      getAll() {
        return new Map(
          ["world-notes", "character-presence"].flatMap((id) => {
            const entry = this.get(id);
            return entry ? [[id, entry]] : [];
          }),
        );
      },
      get: (pluginId: string) =>
        pluginId === "character-presence"
          ? {
              id: "character-presence",
              packageManifest: {
                plugin: {
                  contributes: {
                    data: {
                      assets: {
                        version: 1,
                        accepts: ["character.portrait-assets@1"],
                      },
                    },
                  },
                },
              },
              dataSchemas: {
                assets: {
                  namespace: "assets",
                  schemaVersion: 1,
                  acceptsWorldData: true,
                },
              },
            }
          : undefined,
    } as PluginRegistry;
    app = createTestApp(store, pluginRegistry, {
      mediaStore,
      worldsDirs: [worldsDir],
    });
    for (const sessionId of ["media-a", "media-b"]) {
      await store.createSession({
        phase: "playing",
        setupRuntimes: {},
        metadata: {
          approvalScopeNonce: globalThis.crypto.randomUUID(),
          sessionIncarnationNonce: globalThis.crypto.randomUUID(),
        },
        id: sessionId,
        worldId: "media-world",
        status: "active",
        completedPlayerTurns: 0,

        locale: "zh-CN",
        activePlugins: ["character-presence"],
        createdAt: now,
        updatedAt: now,
      });
      const res = await app.request("/api/worlds/media-world/sync-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, dryRun: false }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        dryRun: false,
        upserted: 1,
        deleted: 0,
        conflicts: [],
      });
    }

    const mediaRowB = await store.getPluginData(
      "media-b",
      "character-presence",
      "assets",
      "mio.png",
    );
    const mediaRef = (mediaRowB?.value as { ref?: { id?: unknown } } | null)
      ?.ref;
    const mediaId = typeof mediaRef?.id === "string" ? mediaRef.id : undefined;
    expect(mediaId).toEqual(expect.any(String));
    expect(await mediaStore.lookup(mediaId!)).not.toBeNull();
    expect(await mediaStore.isReferencedBy(mediaId!, "media-a")).toBe(true);
    expect(await mediaStore.isReferencedBy(mediaId!, "media-b")).toBe(true);

    await writeFile(
      descriptorPath,
      `schemaVersion: 1
sources: {}
`,
    );
    const removeA = await app.request("/api/worlds/media-world/sync-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "media-a", dryRun: false }),
    });

    expect(removeA.status).toBe(200);
    expect(await removeA.json()).toMatchObject({
      dryRun: false,
      upserted: 0,
      deleted: 1,
      conflicts: [],
    });
    expect(
      await store.getPluginData(
        "media-a",
        "character-presence",
        "assets",
        "mio.png",
      ),
    ).toBeNull();
    expect(
      await store.getPluginData(
        "media-b",
        "character-presence",
        "assets",
        "mio.png",
      ),
    ).toBeTruthy();
    expect(await mediaStore.lookup(mediaId!)).not.toBeNull();
    expect(await mediaStore.exists(mediaId!)).toBe(true);
    expect(await mediaStore.isReferencedBy(mediaId!, "media-b")).toBe(true);
    expect(
      (await mediaStore.listRefs()).filter((ref) => ref.mediaId === mediaId),
    ).toContainEqual(expect.objectContaining({ sessionId: "media-b" }));
  });
});
