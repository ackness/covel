import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { expect, it, vi } from "vitest";
import { createWorldFileWatcher } from "../../src/world-file-watcher.js";
import { loadSingleWorld, seedWorlds } from "../../src/world-seed-loader.js";
import { seedAndReconcileWorlds } from "../../src/world-seed-reconcile.js";

it.each(["yaml", "schema", "missing", "unreadable"])(
  "preserves the last complete world on %s dimension failure and recovers after repair",
  async (failure) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "covel-dimension-reload-"),
    );
    const worldDir = path.join(root, "fixture-world");
    const manifestFile = path.join(worldDir, "world.yaml");
    const toneFile = path.join(worldDir, "tone.yaml");
    const store = createMemoryStore();
    const bus = createEventBus(store);
    const emit = vi.spyOn(bus, "emit");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watcher = createWorldFileWatcher(root, store, bus);
    try {
      await mkdir(worldDir);
      const manifest = `schemaVersion: "1.0"
id: fixture-world
name: Fixture world
summary: Synthetic world for dimension recovery.
defaultLocale: en-US
supportedLocales: [en-US]
dimensions:
  tone:
    genres: [fantasy]
    contentRating: teen
dimensionSources:
  tone: tone.yaml
`;
      await writeFile(manifestFile, manifest, "utf8");
      await writeFile(
        toneFile,
        "genres: [mystery]\ncontentRating: teen\n",
        "utf8",
      );
      await seedWorlds(store, root);
      const before = (await store.getWorld("fixture-world"))!;
      expect(before).toMatchObject({
        metadata: { dimensions: { tone: { genres: ["mystery"] } } },
      });
      await store.upsertWorld({ ...before, id: "absent-package" });
      watcher.start();
      if (failure === "missing" || failure === "unreadable") {
        await rm(toneFile);
        if (failure === "unreadable") {
          await mkdir(toneFile);
          // Node's Linux recursive watcher can omit a rapid file-to-directory
          // replacement. Save the manifest to trigger a reload of the bad source.
          await writeFile(manifestFile, manifest, "utf8");
        }
      } else {
        await writeFile(
          toneFile,
          failure === "yaml" ? "genres: [unterminated\n" : "genres: invalid\n",
          "utf8",
        );
      }
      await vi.waitFor(() => expect(warn).toHaveBeenCalled(), {
        timeout: 5000,
      });
      expect(await loadSingleWorld(worldDir)).toBeNull();
      await seedAndReconcileWorlds(store, [root]);
      expect(await store.getWorld("fixture-world")).toEqual(before);
      expect(await store.getWorld("absent-package")).not.toBeNull();
      expect(emit).not.toHaveBeenCalled();

      if (failure === "unreadable") await rm(toneFile, { recursive: true });
      await writeFile(
        toneFile,
        "genres: [adventure]\ncontentRating: teen\n",
        "utf8",
      );
      if (failure === "unreadable") {
        await writeFile(manifestFile, manifest, "utf8");
      }
      await vi.waitFor(
        async () => {
          expect(await store.getWorld("fixture-world")).toMatchObject({
            metadata: { dimensions: { tone: { genres: ["adventure"] } } },
          });
        },
        { timeout: 5000 },
      );
      await seedAndReconcileWorlds(store, [root]);
      expect(await store.getWorld("absent-package")).toBeNull();
    } finally {
      watcher.stop();
      emit.mockRestore();
      warn.mockRestore();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
