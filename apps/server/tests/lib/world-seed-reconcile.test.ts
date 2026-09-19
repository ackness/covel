import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
    const sessionLock = createInProcessSessionLock();
    await seedAndReconcileWorlds(store, [root], sessionLock);
    await writeFile(path.join(root, "broken/world.yaml"), invalid, "utf8");
    await rm(path.join(root, "removed"), { recursive: true });
    await seedAndReconcileWorlds(store, [root], sessionLock);
    expect((await store.listWorlds()).map((world) => world.id).sort()).toEqual([
      "broken",
      "healthy",
      "removed",
    ]);
  },
);

it("keeps worlds when one source cannot be scanned, then reconciles a complete scan", async () => {
  const store = createMemoryStore();
  const sessionLock = createInProcessSessionLock();
  await seedAndReconcileWorlds(store, [root], sessionLock);
  await rm(path.join(root, "removed"), { recursive: true });
  await seedAndReconcileWorlds(
    store,
    [root, path.join(root, "missing-root")],
    sessionLock,
  );
  expect(await store.getWorld("removed")).not.toBeNull();
  await seedAndReconcileWorlds(store, [root], sessionLock);
  expect(await store.getWorld("removed")).toBeNull();
  expect(await store.getWorld("healthy")).not.toBeNull();
});

it("keeps the last good override when a higher-priority package fails to load", async () => {
  const user = path.join(root, "user-root");
  const packageDir = path.join(user, "override");
  await mkdir(packageDir, { recursive: true });
  const manifest =
    'schemaVersion: "1.0"\nid: healthy\nname: User world\nsummary: Override fixture\ndefaultLocale: en-US\ndimensionSources:\n  tone: tone.yaml\n';
  await writeFile(path.join(packageDir, "world.yaml"), manifest, "utf8");
  await writeFile(
    path.join(packageDir, "tone.yaml"),
    "genres: [fantasy]\ncontentRating: teen\n",
    "utf8",
  );
  const store = createMemoryStore();
  const sessionLock = createInProcessSessionLock();
  try {
    await seedAndReconcileWorlds(store, [root, user], sessionLock);
    const before = await store.getWorld("healthy");
    expect(before?.name).toBe("User world");
    await writeFile(
      path.join(packageDir, "tone.yaml"),
      "genres: invalid\n",
      "utf8",
    );
    await seedAndReconcileWorlds(store, [root, user], sessionLock);
    expect(await store.getWorld("healthy")).toEqual(before);
  } finally {
    await store.close();
  }
});

it("does not choose an arbitrary duplicate id or follow a linked manifest", async () => {
  const store = createMemoryStore();
  const sessionLock = createInProcessSessionLock();
  try {
    await seedAndReconcileWorlds(store, [root], sessionLock);
    const before = await store.getWorld("healthy");
    const duplicate = path.join(root, "zzz-duplicate");
    await mkdir(duplicate);
    await writeFile(
      path.join(duplicate, "world.yaml"),
      'schemaVersion: "1.0"\nid: healthy\nname: Duplicate\nsummary: Ambiguous fixture\ndefaultLocale: en-US\n',
      "utf8",
    );
    await seedAndReconcileWorlds(store, [root], sessionLock);
    expect(await store.getWorld("healthy")).toEqual(before);
    await rm(duplicate, { recursive: true });
    const linked = path.join(root, "linked");
    await mkdir(linked);
    await symlink(
      path.join(root, "healthy/world.yaml"),
      path.join(linked, "world.yaml"),
    );
    await rm(path.join(root, "removed"), { recursive: true });
    await seedAndReconcileWorlds(store, [root], sessionLock);
    expect(await store.getWorld("removed")).not.toBeNull();
  } finally {
    await store.close();
  }
});
