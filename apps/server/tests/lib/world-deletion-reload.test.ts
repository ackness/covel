import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { worldOperationLockId } from "../../src/world-lifecycle.js";
import { seedWorlds } from "../../src/world-seed-loader.js";
import { seedAndReconcileWorlds } from "../../src/world-seed-reconcile.js";

const changes = vi.hoisted(() => ({
  notify: undefined as ((event: string, filename: string) => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: (
    _path: string,
    _options: unknown,
    callback: typeof changes.notify,
  ) => {
    changes.notify = callback;
    return {
      close: () => {
        changes.notify = undefined;
      },
    };
  },
}));
import {
  createWorldFileWatcher,
  type WorldFileWatcher,
} from "../../src/world-file-watcher.js";

let root: string;
let directory: string;
let store: ReturnType<typeof createMemoryStore>;
let lock: ReturnType<typeof createInProcessSessionLock>;
let watcher: WorldFileWatcher | undefined;
const worldId = "reload-world";

async function writeManifest(genre: string) {
  await writeFile(
    path.join(directory, "world.yaml"),
    `schemaVersion: "1.0"
id: ${worldId}
name: Reload world
summary: Synthetic deletion fixture.
defaultLocale: en-US
dimensions:
  tone:
    genres: [${genre}]
    contentRating: teen
`,
    "utf8",
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "covel-delete-reload-"));
  directory = path.join(root, "physical-package");
  await mkdir(directory);
  await writeManifest("mystery");
  store = createMemoryStore();
  lock = createInProcessSessionLock();
  watcher = undefined;
  await seedWorlds(store, root, lock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await watcher?.stop();
  await store.close();
  await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("preserves deletion control during startup seeding and hot reload", async () => {
  const world = (await store.getWorld(worldId))!;
  const pending = {
    ...world,
    metadata: {
      ...world.metadata,
      source: "generated-file",
      worldDeletion: {
        nonce: "in-progress",
        startedAt: new Date().toISOString(),
      },
    },
  };
  await store.upsertWorld(pending);
  await writeManifest("fantasy");
  const writes = vi.spyOn(store, "upsertWorld");
  await seedAndReconcileWorlds(store, [root], lock);
  vi.useFakeTimers();
  const bus = createEventBus();
  const emit = vi.spyOn(bus, "emit");
  watcher = createWorldFileWatcher(root, store, bus, lock);
  watcher.start();
  changes.notify!("change", path.join("physical-package", "world.yaml"));
  await vi.advanceTimersByTimeAsync(500);
  await watcher.stop();
  expect(writes).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  expect(await store.getWorld(worldId)).toEqual(pending);
});

async function deleteBeforeAdmission(start: () => Promise<unknown>) {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  const key = worldOperationLockId(worldId);
  const deletion = lock.withLock(key, async () => {
    held.resolve();
    await release.promise;
    await rm(directory, { recursive: true });
    await store.deleteWorld(worldId);
  });
  await held.promise;
  const withLock = lock.withLock.bind(lock);
  vi.spyOn(lock, "withLock").mockImplementation((id, fn) => {
    if (id === key) queued.resolve();
    return withLock(id, fn);
  });
  const pending = start();
  try {
    await queued.promise;
  } finally {
    release.resolve();
    await deletion;
    await pending;
  }
  expect(await store.getWorld(worldId)).toBeNull();
}

it("does not recreate a package removed after the seed inventory was read", async () => {
  await deleteBeforeAdmission(() => seedWorlds(store, root, lock));
});

it("does not recreate a world when a queued watcher reload outlives deletion", async () => {
  vi.useFakeTimers();
  const bus = createEventBus();
  const emit = vi.spyOn(bus, "emit");
  watcher = createWorldFileWatcher(root, store, bus, lock);
  watcher.start();
  await writeManifest("fantasy");
  await deleteBeforeAdmission(async () => {
    changes.notify!("change", path.join("physical-package", "world.yaml"));
    await vi.advanceTimersByTimeAsync(500);
    await watcher!.stop();
  });
  expect(emit).not.toHaveBeenCalled();
});
