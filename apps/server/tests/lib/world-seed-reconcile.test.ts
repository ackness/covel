import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import { seedAndReconcileWorlds } from "../../src/world-seed-reconcile.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-world-inventory-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const id of ["healthy", "broken", "removed"]) {
    await mkdir(path.join(root, id));
    await writeFile(
      path.join(root, id, "world.yaml"),
      `schemaVersion: "1.0"
id: ${id}
name: ${id}
summary: Synthetic world
defaultLocale: en-US
supportedLocales: [en-US]
`,
      "utf8",
    );
  }
  // Non-package containers must not prevent otherwise complete inventories.
  await mkdir(path.join(root, "_archive"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it.each(["id: [unterminated\n", "id: broken\n"])(
  "keeps existing DB worlds after partial package failure: %s",
  async (invalid) => {
    const store = createMemoryStore();
    await seedAndReconcileWorlds(store, [root]);
    await writeFile(path.join(root, "broken/world.yaml"), invalid, "utf8");
    await rm(path.join(root, "removed"), { recursive: true });
    await seedAndReconcileWorlds(store, [root]);
    expect((await store.listWorlds()).map((world) => world.id).sort()).toEqual([
      "broken",
      "healthy",
      "removed",
    ]);
  },
);

it("keeps worlds when one source cannot be scanned, then reconciles a complete scan", async () => {
  const store = createMemoryStore();
  await seedAndReconcileWorlds(store, [root]);
  await rm(path.join(root, "removed"), { recursive: true });
  await seedAndReconcileWorlds(store, [root, path.join(root, "missing-root")]);
  expect(await store.getWorld("removed")).not.toBeNull();
  await seedAndReconcileWorlds(store, [root]);
  expect(await store.getWorld("removed")).toBeNull();
  expect(await store.getWorld("healthy")).not.toBeNull();
});
