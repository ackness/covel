import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { seedAndReconcileWorlds } from "../../src/world-seed-reconcile.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-world-inventory-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const id of ["healthy", "broken", "removed"]) {
    await mkdir(path.join(root, id));
    await writeFile(
      path.join(root, id, "world.yaml"),
      `id: ${id}
name: ${id}
summary: Synthetic world
defaultLocale: en-US
`,
      "utf8",
    );
  }
  // Non-package containers must not prevent otherwise complete inventories.
  await mkdir(path.join(root, "notes"));
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

it("keeps worlds when a root is unreadable, then reconciles a complete scan", async () => {
  const store = createMemoryStore();
  const sessionLock = createInProcessSessionLock();
  await seedAndReconcileWorlds(store, [root], sessionLock);
  await rm(path.join(root, "removed"), { recursive: true });
  await writeFile(path.join(root, "unreadable-root"), "not a directory");
  await seedAndReconcileWorlds(
    store,
    [root, path.join(root, "unreadable-root")],
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
  await mkdir(path.join(packageDir, "data"), { recursive: true });
  const manifest =
    "id: healthy\nname: User world\nsummary: Override fixture\ndefaultLocale: en-US\n";
  await writeFile(path.join(packageDir, "world.yaml"), manifest, "utf8");
  await writeFile(
    path.join(packageDir, "data/dimensions.yaml"),
    "tone:\n  name: tone\n  schema: {}\n  initialValue:\n    genres:\n      - fantasy\n    contentRating: teen\n",
    "utf8",
  );
  const store = createMemoryStore();
  const sessionLock = createInProcessSessionLock();
  try {
    await seedAndReconcileWorlds(store, [root, user], sessionLock);
    const before = await store.getWorld("healthy");
    expect(before?.name).toBe("User world");
    await writeFile(
      path.join(packageDir, "data/dimensions.yaml"),
      "tone:\n  genres: invalid\n",
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
  const outside = await mkdtemp(path.join(tmpdir(), "covel-world-linked-"));
  try {
    await seedAndReconcileWorlds(store, [root], sessionLock);
    const before = await store.getWorld("healthy");
    const duplicate = path.join(root, "zzz-duplicate");
    await mkdir(duplicate);
    await writeFile(
      path.join(duplicate, "world.yaml"),
      "id: healthy\nname: Duplicate\nsummary: Ambiguous fixture\ndefaultLocale: en-US\n",
      "utf8",
    );
    await seedAndReconcileWorlds(store, [root], sessionLock);
    expect(await store.getWorld("healthy")).toEqual(before);
    await rm(duplicate, { recursive: true });
    const linked = path.join(root, "linked");
    await mkdir(linked);
    // The target carries an id no other world has, so only the link rule can
    // keep it out of the store.
    const target = path.join(outside, "world.yaml");
    await writeFile(
      target,
      "id: linked-world\nname: Linked\nsummary: Linked fixture\ndefaultLocale: en-US\n",
      "utf8",
    );
    await symlink(target, path.join(linked, "world.yaml"));
    await rm(path.join(root, "removed"), { recursive: true });
    await seedAndReconcileWorlds(store, [root], sessionLock);
    expect(await store.getWorld("linked-world")).toBeNull();
    expect(await store.getWorld("removed")).not.toBeNull();
  } finally {
    await rm(outside, { recursive: true, force: true });
    await store.close();
  }
});

it("refreshes bundled worlds when the user directory does not exist", async () => {
  const store = createMemoryStore();
  const lock = createInProcessSessionLock();
  await seedAndReconcileWorlds(store, [root], lock);
  await writeFile(path.join(root, "healthy/WORLD.md"), "Updated lore");
  await seedAndReconcileWorlds(
    store,
    [root, path.join(root, "missing-root")],
    lock,
  );
  expect((await store.getWorld("healthy"))?.lore).toBe("Updated lore");
  expect(await store.listWorlds()).toHaveLength(3);
  expect(console.warn).not.toHaveBeenCalled();
  await store.close();
});

it.each(["missing", "yaml", "schema"])(
  "keeps the whole previous world when a dimension source has a %s error",
  async (failure) => {
    const store = createMemoryStore();
    const lock = createInProcessSessionLock();
    const dir = path.join(root, "healthy");
    await mkdir(path.join(dir, "data"));
    await writeFile(
      path.join(dir, "world.data.yaml"),
      "sources:\n  dimensions:\n    kind: yaml\n    path: data/dimensions.yaml\n    to: world:metadata.dimensions\n",
    );
    // Explicit descriptors keep a missing source declared.
    const manifest = path.join(dir, "world.yaml");
    await writeFile(
      manifest,
      "id: healthy\nname: Healthy\nsummary: Fixture\ndefaultLocale: en-US\nworldData: world.data.yaml\n",
    );
    const file = path.join(dir, "data/dimensions.yaml");
    await writeFile(
      file,
      "alarm:\n  name: Alarm\n  schema: { type: number }\n  initialValue: 0\n",
    );
    await seedAndReconcileWorlds(store, [root], lock);
    const before = await store.getWorld("healthy");
    expect(before?.metadata?.dimensions).toHaveProperty("alarm");
    await writeFile(
      path.join(dir, "WORLD.md"),
      "Should not replace prior lore",
    );
    if (failure === "missing") await rm(file);
    else
      await writeFile(
        file,
        failure === "yaml" ? "[unterminated" : "alarm: invalid",
      );
    await rm(path.join(root, "removed"), { recursive: true });
    await seedAndReconcileWorlds(store, [root], lock);
    expect(await store.getWorld("healthy")).toEqual(before);
    expect(await store.getWorld("removed")).not.toBeNull();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "MVP only projects",
    );
    await store.close();
  },
);
