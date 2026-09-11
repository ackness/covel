import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { expect, it, vi } from "vitest";
import { createWorldFileWatcher } from "../../src/world-file-watcher.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";

it("reloads nested dimension files and notifies sessions on supported platforms", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "covel-world-watch-"));
  const worldDir = path.join(root, "fixture-world");
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
    const record = await loadSingleWorld(worldDir);
    expect(record).not.toBeNull();
    await store.upsertWorld(record!);
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
          metadata: { dimensions: { tone: { genres: ["adventure"] } } },
        });
        expect(emit).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: "watch-session",
            payload: expect.objectContaining({
              _subType: "world.dimensions.changed",
              changedKeys: ["tone"],
            }),
          }),
        );
      },
      { timeout: 5000 },
    );
  } finally {
    watcher.stop();
    emit.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
