/**
 * The world record is the world; a package's files are only what it was
 * installed from (F-003, F-007). An edit in the app reaches new sessions and
 * syncs, survives the startup seed and a file reload, and goes away only when
 * the player restores the package version.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  mkdtemp,
  mkdir,
  open,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRpcApprovalGate } from "@covel/approval";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { worldRoutes } from "../../src/routes/api/worlds.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import { seedWorlds } from "../../src/world-seed-loader.js";
import { registerDimensionProvider } from "../helpers/dimension-provider.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const stamina = (initialValue: number) => ({
  name: "Stamina",
  schema: { type: "integer", minimum: 0 },
  initialValue,
});

function manifest(name: string, initialValue: number) {
  return JSON.stringify({
    id: "pkg",
    name,
    summary: "A package world.",
    defaultLocale: "en-US",
    dimensions: { stamina: stamina(initialValue) },
  });
}

let root: string;
let store: DataStore;
let registry: PluginRegistry;
let sessionLock: SessionLock;
let app: Hono;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-world-record-"));
  await mkdir(path.join(root, "pkg"));
  await writeFile(path.join(root, "pkg", "world.yaml"), manifest("Pkg", 1));
  store = createMemoryStore();
  registry = createPluginRegistry();
  await registerDimensionProvider(registry);
  // A bundled plugin: a session turns it on without an approval.
  registry.register({ ...registry.get("world-init")!, source: "builtin" });
  sessionLock = createInProcessSessionLock();
  const eventBus = createEventBus();
  const rpcApprovalGate = createRpcApprovalGate();
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("eventBus", eventBus);
    c.set("pluginRegistry", registry);
    c.set("rpcApprovalGate", rpcApprovalGate);
    c.set("activatePluginServerCode", async () => {});
    c.set("sessionLock", sessionLock);
    c.set("worldsDirs", [root]);
    await next();
  });
  app.route("/api/worlds", worldRoutes);
  app.route("/api/sessions", sessionRoutes);
  await seedWorlds(store, root, sessionLock);
});

afterEach(async () => {
  vi.clearAllMocks();
  await store.close();
  await rm(root, { recursive: true, force: true });
});

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function editDimensions(initialValue: number) {
  const response = await app.request("/api/worlds/pkg", {
    ...json({ dimensions: { stamina: stamina(initialValue) } }),
    method: "PATCH",
  });
  expect(response.status).toBe(200);
}

async function startSession(id: string) {
  const response = await app.request(
    "/api/sessions",
    json({ id, worldId: "pkg", plugins: ["world-init"], locale: "en-US" }),
  );
  expect(response.status).toBe(201);
}

async function staminaOf(sessionId: string) {
  return (
    await store.getPluginData(sessionId, "world-init", "_dimensions", "stamina")
  )?.value as { value: number; definition: { initialValue: number } };
}

describe("the world record is the source of truth", () => {
  it.each(["mtime", "size"])(
    "reuses package hashes for list/detail reads and invalidates them on a file %s change",
    async (changedStat) => {
      const media = path.join(root, "pkg", "media", "cover.webp");
      await mkdir(path.dirname(media));
      await writeFile(media, "original");
      await seedWorlds(store, root, sessionLock);
      const imported = (await store.getWorld("pkg"))?.metadata?.packageDigest;
      const initial = await stat(media);
      const touched = new Date(initial.mtimeMs + 2000);
      await utimes(media, initial.atime, touched);
      const list = async () => {
        const response = await app.request("/api/worlds");
        expect(response.status).toBe(200);
        return (await response.json()).items[0];
      };

      // A stat-only change rehashes once but keeps the content-based status.
      vi.mocked(open).mockClear();
      for (const world of await Promise.all([list(), list()]))
        expect(world).toMatchObject({ updateAvailable: false });
      expect(open).toHaveBeenCalledTimes(2); // Manifest + media, not host receipts.
      vi.mocked(open).mockClear();
      expect(await list()).toMatchObject({ updateAvailable: false });
      const detail = await app.request("/api/worlds/pkg");
      expect(await detail.json()).toMatchObject({ updateAvailable: false });
      expect(open).not.toHaveBeenCalled();

      await writeFile(
        media,
        changedStat === "mtime" ? "modified" : "longer content",
      );
      await utimes(
        media,
        initial.atime,
        changedStat === "mtime" ? new Date(initial.mtimeMs + 4000) : touched,
      );
      expect(await list()).toMatchObject({ updateAvailable: true });
      expect(open).toHaveBeenCalledTimes(2);
      expect((await store.getWorld("pkg"))?.metadata?.packageDigest).toBe(
        imported,
      );
    },
  );

  it.each(["file", "generated-file"])(
    "reports package updates for %s worlds and clears them after restore",
    async (source) => {
      const seeded = (await store.getWorld("pkg"))!;
      await store.upsertWorld({
        ...seeded,
        metadata: { ...seeded.metadata, source },
      });
      const listed = async () => {
        const response = await app.request("/api/worlds");
        expect(response.status).toBe(200);
        return (await response.json()).items.find(
          (world: { id: string }) => world.id === "pkg",
        );
      };
      expect(await listed()).toMatchObject({ updateAvailable: false });
      expect(seeded.metadata?.packageDigest).toMatch(/^sha256:/);
      await startSession("kept");
      const session = await store.getSession("kept");
      await editDimensions(5);
      expect(await listed()).toMatchObject({ updateAvailable: false });

      await writeFile(path.join(root, "pkg", "world.yaml"), manifest("New", 3));
      await seedWorlds(store, root, sessionLock);
      expect(await listed()).toMatchObject({
        name: "Pkg",
        updateAvailable: true,
      });
      expect(await (await app.request("/api/worlds/pkg")).json()).toMatchObject(
        {
          updateAvailable: true,
        },
      );
      expect((await store.getWorld("pkg"))?.metadata?.packageDigest).toBe(
        seeded.metadata?.packageDigest,
      );

      const response = await app.request(
        "/api/worlds/pkg/restore-package",
        json({}),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        name: "New",
        updateAvailable: false,
      });
      expect(await listed()).toMatchObject({ updateAvailable: false });
      expect(await store.getSession("kept")).toEqual(session);
      expect((await staminaOf("kept")).value).toBe(1);
    },
  );

  it.each(["WORLD.md", "data/notes.json", "media/cover.webp"])(
    "detects additions, edits and removals of %s without a version bump",
    async (file) => {
      const filename = path.join(root, "pkg", file);
      await mkdir(path.dirname(filename), { recursive: true });
      await editDimensions(5);
      const available = async () =>
        (await (await app.request("/api/worlds/pkg")).json()).updateAvailable;
      await writeFile(filename, "first");
      expect(await available()).toBe(true);
      await app.request("/api/worlds/pkg/restore-package", json({}));
      expect(await available()).toBe(false);
      await writeFile(filename, "other");
      expect(await available()).toBe(true);
      await writeFile(filename, "first");
      expect(await available()).toBe(false);
      await rm(filename);
      expect(await available()).toBe(true);
    },
  );

  it("omits update status for missing packages and worlds made in the app", async () => {
    const created = await app.request(
      "/api/worlds",
      json({ id: "stored", name: "Stored" }),
    );
    expect(created.status).toBe(201);
    await rm(path.join(root, "pkg"), { recursive: true });
    const response = await app.request("/api/worlds");
    expect(response.status).toBe(200);
    const { items } = await response.json();
    expect(items).toHaveLength(2);
    for (const item of items)
      expect(item).not.toHaveProperty("updateAvailable");
  });

  it("keeps the imported fingerprint when a metadata patch tries to replace it", async () => {
    const seeded = (await store.getWorld("pkg"))!;
    const response = await app.request("/api/worlds/pkg", {
      ...json({ metadata: { packageDigest: "forged" } }),
      method: "PATCH",
    });
    expect(response.status).toBe(200);
    expect((await store.getWorld("pkg"))?.metadata?.packageDigest).toBe(
      seeded.metadata?.packageDigest,
    );
  });

  it("ignores host bookkeeping and never follows symlinks outside the package", async () => {
    await writeFile(path.join(root, "pkg", ".covel-install.json"), "{}");
    await writeFile(path.join(root, "pkg", ".covel-generated.json"), "{}");
    await writeFile(path.join(root, "pkg", ".DS_Store"), "metadata");
    await mkdir(path.join(root, "pkg", ".git"));
    await writeFile(path.join(root, "pkg", ".git", "config"), "metadata");
    await writeFile(path.join(root, "outside.txt"), "outside");
    await symlink(
      path.join(root, "outside.txt"),
      path.join(root, "pkg", "linked.txt"),
    );
    await symlink(root, path.join(root, "pkg", "linked-directory"));
    vi.mocked(open).mockClear();
    const response = await app.request("/api/worlds/pkg");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ updateAvailable: false });
    expect(open).not.toHaveBeenCalled();
  });

  it("starts a new session with the dimensions saved in the app, not the package's", async () => {
    await editDimensions(5);
    // The files change too, but nothing loaded them into the record.
    await writeFile(path.join(root, "pkg", "world.yaml"), manifest("Pkg", 7));

    await startSession("s1");
    expect(await staminaOf("s1")).toMatchObject({
      value: 5,
      definition: { initialValue: 5 },
    });
  });

  it("syncs a session to the record's dimensions", async () => {
    await startSession("s1");
    expect((await staminaOf("s1")).value).toBe(1);
    const sync = async () => {
      const response = await app.request(
        "/api/worlds/pkg/sync-dimensions",
        json({ sessionId: "s1" }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        upserted: number;
        unchanged: number;
        conflicts: unknown[];
      };
    };
    // A record loaded from unchanged files matches what the session imported.
    expect(await sync()).toMatchObject({
      upserted: 0,
      unchanged: 1,
      conflicts: [],
    });

    await editDimensions(6);
    expect(await sync()).toMatchObject({ upserted: 1, conflicts: [] });
    expect(await staminaOf("s1")).toMatchObject({
      value: 6,
      definition: { initialValue: 6 },
    });
  });

  it.each([
    ["a bundled or hand-placed package", { source: "file" }],
    ["a ZIP install", { source: "generated-file" }],
    ["a generated package", { source: "generated-file", generated: true }],
    ["a GitHub install", { source: "generated-file", packageManaged: true }],
  ])(
    "keeps an edit to %s when the package is loaded again",
    async (_, origin) => {
      const seeded = (await store.getWorld("pkg"))!;
      await store.upsertWorld({
        ...seeded,
        metadata: { ...seeded.metadata, ...origin },
      });
      const response = await app.request("/api/worlds/pkg", {
        ...json({ name: "Edited" }),
        method: "PATCH",
      });
      expect(response.status).toBe(200);

      await writeFile(path.join(root, "pkg", "world.yaml"), manifest("New", 2));
      await seedWorlds(store, root, sessionLock);

      const world = (await store.getWorld("pkg"))!;
      expect(world.name).toBe("Edited");
      expect(world.metadata).toMatchObject({
        ...origin,
        packageModified: true,
      });
    },
  );

  it("goes back to the package version only when the player restores it", async () => {
    await editDimensions(5);
    await writeFile(path.join(root, "pkg", "world.yaml"), manifest("New", 3));

    const response = await app.request(
      "/api/worlds/pkg/restore-package",
      json({}),
    );
    expect(response.status).toBe(200);
    const restored = (await store.getWorld("pkg"))!;
    expect(restored.name).toBe("New");
    expect(restored.metadata?.packageModified).toBeUndefined();
    expect(restored.metadata?.source).toBe("file");
    await startSession("s1");
    expect((await staminaOf("s1")).value).toBe(3);

    // The record follows its files again.
    await writeFile(path.join(root, "pkg", "world.yaml"), manifest("Newer", 4));
    await seedWorlds(store, root, sessionLock);
    expect((await store.getWorld("pkg"))!.name).toBe("Newer");
  });

  it("refuses to restore a world that has no package", async () => {
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "stored",
      name: "Stored",
      description: "",
      metadata: { source: "server-store" },
      createdAt: now,
      updatedAt: now,
    });
    const response = await app.request(
      "/api/worlds/stored/restore-package",
      json({}),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "world_not_from_package",
    });
  });
});
