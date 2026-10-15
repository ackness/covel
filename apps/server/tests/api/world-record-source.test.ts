/**
 * The world record is the world; a package's files are only what it was
 * installed from (F-003, F-007). An edit in the app reaches new sessions and
 * syncs, survives the startup seed and a file reload, and goes away only when
 * the player restores the package version.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
