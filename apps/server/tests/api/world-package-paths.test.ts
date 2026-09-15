import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import {
  makeSession,
  makeWorld,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import { worldCrudRoutes } from "../../src/routes/api/worlds/crud.js";
import type { WorldEnv } from "../../src/routes/api/worlds/shared.js";
import { importWorldDataForSession } from "../../src/world-data/session-import.js";
import { resolveWorldRoot } from "../../src/world-data/session-import/utils.js";

let root: string;
let bundled: string;
let user: string;
let store: ReturnType<typeof createMemoryStore>;
let app: Hono<WorldEnv>;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "covel-package-paths-"));
  bundled = path.join(root, "bundled");
  user = path.join(root, "user");
  await mkdir(bundled);
  await mkdir(user);
  store = createMemoryStore();
  app = new Hono<WorldEnv>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("worldsDirs", [bundled, user]);
    await next();
  });
  app.route("/api/worlds", worldCrudRoutes);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(root, { recursive: true, force: true });
});
async function makePackage(
  base: string,
  directory = "logical-world",
  id = "logical-world",
) {
  const dir = path.join(base, directory);
  await mkdir(path.join(dir, "data"), { recursive: true });
  await writeFile(
    path.join(dir, "world.yaml"),
    `id: ${id}\nworldData: data/world.data.yaml\n`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "data/world.data.yaml"),
    "schemaVersion: 1\nsources:\n  lore:\n    kind: json\n    path: data/lore.json\n    to: lorebook\n    key: id\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "data/lore.json"),
    JSON.stringify({
      id: "clue",
      content: base === user ? "User clue" : "Bundled clue",
    }),
    "utf8",
  );
  return dir;
}
async function seedWorld(
  storage: unknown = { path: user, backend: "file", scope: "server" },
) {
  await store.upsertWorld(
    makeWorld({
      id: "logical-world",
      metadata: {
        source: "generated-file",
        ...(storage === undefined ? {} : { storage }),
      },
    }),
  );
}
const removeWorld = () =>
  app.request("/api/worlds/logical-world", { method: "DELETE" });

it("imports the higher-priority manifest id from a renamed directory", async () => {
  await makePackage(bundled);
  const physical = await makePackage(user, "physical-folder");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await mkdir(path.join(user, "broken"));
  await writeFile(
    path.join(user, "broken/world.yaml"),
    "id: [broken\n",
    "utf8",
  );
  expect(
    await resolveWorldRoot("logical-world", [
      bundled,
      user,
      path.join(root, "absent"),
    ]),
  ).toBe(await realpath(physical));
  await store.createSession(
    makeSession({ id: "session", worldId: "logical-world" }),
  );
  const result = await importWorldDataForSession({
    store,
    sessionId: "session",
    worldId: "logical-world",
    worldsDirs: [bundled, user],
    covelHome: path.join(root, "home"),
    now: new Date().toISOString(),
  });
  expect(result.written).toBe(1);
  expect(
    (await store.listSessionLorebookEntries("session"))[0]!.content,
  ).toContain("User clue");
});

it("deletes only the bound user package, preserving a bundled package with the same id", async () => {
  const original = await makePackage(bundled);
  const owned = await makePackage(user, "renamed-world");
  await seedWorld();
  expect((await removeWorld()).status).toBe(200);
  await expect(access(owned)).rejects.toMatchObject({ code: "ENOENT" });
  await access(path.join(original, "world.yaml"));
  expect(await store.getWorld("logical-world")).toBeNull();
});

it.each([
  "ambiguous-legacy",
  "ambiguous-bound",
  "missing",
  "wrong-id",
  "outside",
  "symlink",
  "manifest-symlink",
])(
  "rejects unsafe deletion when package resolution is %s",
  async (scenario) => {
    const original = await makePackage(bundled);
    await seedWorld();
    if (scenario === "ambiguous-legacy") {
      await makePackage(user);
      await store.upsertWorld(
        makeWorld({
          id: "logical-world",
          metadata: { source: "generated-file" },
        }),
      );
    } else if (scenario === "ambiguous-bound") {
      await makePackage(user, "one");
      await makePackage(user, "two");
    } else if (scenario === "wrong-id") {
      await makePackage(user, "logical-world", "different-world");
    } else if (scenario === "outside") {
      await seedWorld({ path: root });
    } else if (scenario === "symlink") {
      await symlink(original, path.join(user, "logical-world"), "dir");
    } else if (scenario === "manifest-symlink") {
      await mkdir(path.join(user, "logical-world"));
      await symlink(
        path.join(original, "world.yaml"),
        path.join(user, "logical-world/world.yaml"),
      );
    }
    const before = await store.getWorld("logical-world");
    const response = await removeWorld();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "world_package_unresolved",
    });
    expect(await store.getWorld("logical-world")).toEqual(before);
    await access(path.join(original, "world.yaml"));
  },
);

it("supports a unique legacy package and rejects duplicate ids inside one import root", async () => {
  await makePackage(user, "one");
  await makePackage(user, "two");
  await expect(resolveWorldRoot("logical-world", [user])).rejects.toThrow(
    "Multiple world packages",
  );
  await rm(path.join(user, "two"), { recursive: true });
  await store.upsertWorld(
    makeWorld({ id: "logical-world", metadata: { source: "generated-file" } }),
  );
  expect((await removeWorld()).status).toBe(200);
});
