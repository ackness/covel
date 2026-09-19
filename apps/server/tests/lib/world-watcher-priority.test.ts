import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { expect, it, vi } from "vitest";
import { createWorldFileWatcher } from "../../src/world-file-watcher.js";
import { seedAndReconcileWorlds } from "../../src/world-seed-reconcile.js";

it("ignores shadowed packages while reloading the higher-priority renamed package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "covel-watch-priority-"));
  const roots = [path.join(root, "bundled"), path.join(root, "user")];
  const packages = [
    path.join(roots[0]!, "shared-world"),
    path.join(roots[1]!, "renamed-package"),
  ];
  const store = createMemoryStore();
  const sessionLock = createInProcessSessionLock();
  const bus = createEventBus(store);
  const watchers = roots.map((dir) =>
    createWorldFileWatcher(dir, store, bus, sessionLock, roots),
  );
  const update = (dir: string, genre: string) =>
    writeFile(
      path.join(dir, "tone.yaml"),
      `genres: [${genre}]\ncontentRating: teen\n`,
      "utf8",
    );
  try {
    for (const [index, dir] of packages.entries()) {
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "world.yaml"),
        'schemaVersion: "1.0"\nid: shared-world\nname: Synthetic world\nsummary: Priority fixture.\ndefaultLocale: en-US\ndimensionSources:\n  tone: tone.yaml\n',
        "utf8",
      );
      await update(dir, index === 0 ? "mystery" : "fantasy");
    }
    await seedAndReconcileWorlds(store, roots, sessionLock);
    const before = await store.getWorld("shared-world");
    expect(before?.metadata?.dimensions).toMatchObject({
      tone: { genres: ["fantasy"] },
    });
    const upsert = vi.spyOn(store, "upsertWorld");
    for (const watcher of watchers) watcher.start();
    await update(packages[0]!, "adventure");
    // Let the native watcher and its 500ms debounce process the shadowed edit.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(upsert).not.toHaveBeenCalled();
    expect(await store.getWorld("shared-world")).toEqual(before);
    await update(packages[1]!, "horror");
    await vi.waitFor(
      async () => {
        expect(await store.getWorld("shared-world")).toMatchObject({
          metadata: { dimensions: { tone: { genres: ["horror"] } } },
        });
      },
      { timeout: 5000 },
    );
    upsert.mockRestore();
  } finally {
    for (const watcher of watchers) await watcher.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
