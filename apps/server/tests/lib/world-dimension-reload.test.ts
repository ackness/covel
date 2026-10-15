import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import { expect, it, vi } from "vitest";

// This suite checks invalid-package recovery, not native event delivery.
// Real fs.watch coverage lives in world-file-watcher.test.ts; an immediate
// write after watch() can be coalesced by the OS during registration.
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
import { createWorldFileWatcher } from "../../src/world-file-watcher.js";
import { loadSingleWorld, seedWorlds } from "../../src/world-seed-loader.js";
import { seedAndReconcileWorlds } from "../../src/world-seed-reconcile.js";

// A missing data/dimensions.yaml is no failure: the world has no dimensions.
it.each(["yaml", "schema"])(
  "preserves the last complete world on %s dimension failure and recovers after repair",
  async (failure) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "covel-dimension-reload-"),
    );
    const worldDir = path.join(root, "fixture-world");
    const manifestFile = path.join(worldDir, "world.yaml");
    const toneFile = path.join(worldDir, "data/dimensions.yaml");
    const store = createMemoryStore();
    const sessionLock = createInProcessSessionLock();
    const bus = createEventBus(store);
    const emit = vi.spyOn(bus, "emit");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watcher = createWorldFileWatcher(root, store, bus, sessionLock);
    try {
      await mkdir(path.join(worldDir, "data"), { recursive: true });
      const manifest = `id: fixture-world
name: Fixture world
summary: Synthetic world for dimension recovery.
defaultLocale: en-US
`;
      await writeFile(manifestFile, manifest, "utf8");
      await writeFile(
        toneFile,
        "tone:\n  name: tone\n  schema: {}\n  initialValue:\n    genres:\n      - mystery\n    contentRating: teen\n",
        "utf8",
      );
      await seedWorlds(store, root, sessionLock);
      const before = (await store.getWorld("fixture-world"))!;
      expect(before).toMatchObject({
        metadata: {
          dimensions: {
            tone: {
              name: "tone",
              schema: {},
              initialValue: { genres: ["mystery"] },
            },
          },
        },
      });
      await store.upsertWorld({ ...before, id: "absent-package" });
      watcher.start();
      await writeFile(
        toneFile,
        failure === "yaml"
          ? "tone: [unterminated\n"
          : "tone:\n  genres: invalid\n",
        "utf8",
      );
      changes.notify!(
        "change",
        path.join("fixture-world", "data/dimensions.yaml"),
      );
      await vi.waitFor(() => expect(warn).toHaveBeenCalled(), {
        timeout: 5000,
      });
      expect(await loadSingleWorld(worldDir)).toBeNull();
      await seedAndReconcileWorlds(store, [root], sessionLock);
      expect(await store.getWorld("fixture-world")).toEqual(before);
      expect(await store.getWorld("absent-package")).not.toBeNull();
      expect(emit).not.toHaveBeenCalled();

      await writeFile(
        toneFile,
        "tone:\n  name: tone\n  schema: {}\n  initialValue:\n    genres:\n      - adventure\n    contentRating: teen\n",
        "utf8",
      );
      changes.notify!(
        "change",
        path.join("fixture-world", "data/dimensions.yaml"),
      );
      await vi.waitFor(
        async () => {
          expect(await store.getWorld("fixture-world")).toMatchObject({
            metadata: {
              dimensions: {
                tone: {
                  name: "tone",
                  schema: {},
                  initialValue: { genres: ["adventure"] },
                },
              },
            },
          });
        },
        { timeout: 5000 },
      );
      await seedAndReconcileWorlds(store, [root], sessionLock);
      expect(await store.getWorld("absent-package")).toBeNull();
    } finally {
      await watcher.stop();
      emit.mockRestore();
      warn.mockRestore();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
