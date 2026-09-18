import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createWorldFileWatcher } from "../../src/world-file-watcher.js";
import { loadSingleWorld, seedWorlds } from "../../src/world-seed-loader.js";
import { worldCrudRoutes } from "../../src/routes/api/worlds/crud.js";
import type { WorldEnv } from "../../src/routes/api/worlds/shared.js";

it.each(["fixture-world", "physical-folder"])(
  "reloads the manifest world id from directory %s and notifies its sessions",
  async (directoryName) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "covel-world-watch-"));
    const worldDir = path.join(root, directoryName);
    const dimensionsDir = path.join(worldDir, "dimensions");
    const store = createMemoryStore();
    const bus = createEventBus(store);
    const emit = vi.spyOn(bus, "emit");
    const watcher = createWorldFileWatcher(root, store, bus);
    try {
      await mkdir(dimensionsDir, { recursive: true });
      await writeFile(
        path.join(worldDir, "world.yaml"),
        `schemaVersion: "1.0"
id: fixture-world
name: Fixture world
version: "0.1.0"
summary: A world for file watcher tests.
defaultLocale: en-US
supportedLocales: [en-US]
dimensionSources:
  tone: dimensions/tone.yaml
`,
        "utf8",
      );
      const dimensionFile = path.join(dimensionsDir, "tone.yaml");
      await writeFile(
        dimensionFile,
        "genres: [mystery]\ncontentRating: teen\n",
        "utf8",
      );
      const storage = {
        scope: "server",
        backend: "file",
        path: root,
        durable: true,
      };
      const loaded = await loadSingleWorld(worldDir, {
        source: "generated-file",
        storage,
      });
      const record = loaded && {
        ...loaded,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      expect(record).not.toBeNull();
      await store.upsertWorld(record!);
      const decoy =
        directoryName === "fixture-world"
          ? undefined
          : { ...record!, id: directoryName };
      if (decoy) await store.upsertWorld(decoy);
      const decoyBefore = decoy ? await store.getWorld(directoryName) : null;
      const now = new Date().toISOString();
      await store.createSession({
        id: "watch-session",
        worldId: "fixture-world",
        status: "active",
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: [],
        createdAt: now,
        updatedAt: now,
      });

      watcher.start();
      await writeFile(
        dimensionFile,
        "genres: [adventure]\ncontentRating: teen\n",
        "utf8",
      );

      await vi.waitFor(
        async () => {
          expect(await store.getWorld("fixture-world")).toMatchObject({
            createdAt: record!.createdAt,
            metadata: {
              source: "generated-file",
              storage,
              dimensions: { tone: { genres: ["adventure"] } },
            },
          });
          expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({
              sessionId: "watch-session",
              payload: expect.objectContaining({
                _subType: "world.dimensions.changed",
                worldId: "fixture-world",
                changedKeys: ["tone"],
              }),
            }),
          );
        },
        { timeout: 5000 },
      );
      if (decoy)
        expect(await store.getWorld(directoryName)).toEqual(decoyBefore);
      // Boot-time seeding must preserve the same provenance as hot reload.
      await seedWorlds(store, root);
      expect(await store.getWorld("fixture-world")).toMatchObject({
        createdAt: record!.createdAt,
        metadata: { source: "generated-file", storage },
      });
      if (directoryName === "fixture-world") {
        const app = new Hono<WorldEnv>();
        app.use("*", async (c, next) => {
          c.set("store", store);
          c.set("worldsDirs", [root]);
          await next();
        });
        app.route("/api/worlds", worldCrudRoutes);
        const response = await app.request("/api/worlds/fixture-world", {
          method: "DELETE",
        });
        expect(response.status).toBe(200);
        expect(await store.getWorld("fixture-world")).toBeNull();
        await expect(access(worldDir)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await watcher.stop();
      emit.mockRestore();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
