import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import yazl from "yazl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import { installRoutes } from "../../src/routes/api/install.js";
import { worldCrudRoutes } from "../../src/routes/api/worlds/crud.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { applyPendingPackageUpdates } from "../../src/routes/api/install/package-updates.js";
import { seedWorlds } from "../../src/world-seed-loader.js";
import type { GithubPluginPreview } from "@covel/shared";

const repo = "https://github.com/example/worlds";
const sha = "a".repeat(40);
let root: string;
let app: Hono;
let archive: Buffer;
let store: ReturnType<typeof createMemoryStore>;
const lock = createInProcessSessionLock();
function files(id = "test-world", version = "1.0.0") {
  return {
    [`worlds/${id}/world.yaml`]: JSON.stringify({
      schemaVersion: "1.0",
      id,
      version,
      name: { "en-US": "Test", "zh-CN": "测试" },
      summary: "A world",
      defaultLocale: "en-US",
      supportedLocales: ["en-US", "zh-CN"],
    }),
    [`worlds/${id}/WORLD.md`]: "A lighthouse waits for a keeper.",
  };
}
async function zip(contents: Record<string, string>) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(contents))
    zip.addBuffer(Buffer.from(content), `worlds-commit/${name}`);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  return result;
}
const request = (
  route: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) =>
  app.request(`/api/install/${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function preview(): Promise<GithubPluginPreview[]> {
  const response = await request("world/github/preview", { url: repo });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.items;
}
async function install() {
  const [item] = await preview();
  const response = await request("world/github", {
    token: item!.token,
    acceptRisk: true,
  });
  expect(response.status, JSON.stringify(await response.json())).toBe(201);
  return item!;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-world-github-"));
  store = createMemoryStore();
  vi.stubEnv("COVEL_USER_WORLDS_DIR", root);
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("NODE_ENV", "test");
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("sessionLock", lock);
    c.set("worldsDirs", [root]);
    await next();
  });
  app.route("/api/install", installRoutes);
  app.route("/api/worlds", worldCrudRoutes);
  archive = await zip(files());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/commits?")) return Response.json([{ sha }]);
      if (url.startsWith("https://codeload.github.com/"))
        return new Response(new Uint8Array(archive));
      throw new Error(`Unexpected URL: ${url}`);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await store.close();
  await rm(root, { recursive: true, force: true });
});

it("discovers multiple worlds and installs only the selected directory without running scripts", async () => {
  archive = await zip({
    ...files(),
    ...files("second-world"),
    "worlds/test-world/script.js": 'throw new Error("Must not execute");',
  });
  const items = await preview();
  expect(items.map((item) => item.id)).toEqual(["second-world", "test-world"]);
  expect(await readdir(root)).toEqual([]);
  const response = await request("world/github", {
    token: items[1]!.token,
    acceptRisk: true,
  });
  expect(await response.json()).toMatchObject({
    kind: "world",
    id: "test-world",
    restartRequired: false,
  });
  expect(await readdir(root)).toEqual(["test-world"]);
  expect((await store.getWorld("test-world"))?.metadata).toMatchObject({
    packageManaged: true,
    source: "generated-file",
  });
  expect(await store.getWorld("second-world")).toBeNull();
  expect((await (await request("worlds")).json()).items[0].source.path).toBe(
    "worlds/test-world",
  );
});
it("requires consent and prevents cross-kind token replay and duplicate installation", async () => {
  const [item] = await preview();
  expect((await request("world/github", { token: item!.token })).status).toBe(
    400,
  );
  expect(
    (await request("plugin/github", { token: item!.token, acceptRisk: true }))
      .status,
  ).toBe(400);
  await install();
  expect(
    (await request("world/github", { token: item!.token, acceptRisk: true }))
      .status,
  ).toBe(409);
});
it("refuses a conflicting stored world before creating files", async () => {
  const [item] = await preview();
  await store.createWorld({
    id: "test-world",
    name: "Existing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  expect(
    (await request("world/github", { token: item!.token, acceptRisk: true }))
      .status,
  ).toBe(409);
  expect(await readdir(root)).toEqual([]);
  expect((await store.getWorld("test-world"))?.name).toBe("Existing");
});
it("rejects external and missing world-data references", async () => {
  for (const worldData of ["../secret.yaml", "data/missing.yaml"]) {
    const fixture = files();
    const manifest = JSON.parse(fixture["worlds/test-world/world.yaml"]!);
    fixture["worlds/test-world/world.yaml"] = JSON.stringify({
      ...manifest,
      worldData,
    });
    archive = await zip(fixture);
    expect((await request("world/github/preview", { url: repo })).status).toBe(
      400,
    );
    expect(await readdir(root)).toEqual([]);
  }
});
it("stages reviewed updates, then replaces the package at restart without touching sessions", async () => {
  await install();
  const original = await readFile(
    path.join(root, "test-world/world.yaml"),
    "utf8",
  );
  expect(
    (
      await (
        await request("world/github/update/preview", { id: "test-world" })
      ).json()
    ).status,
  ).toBe("current");
  archive = await zip(files("test-world", "1.1.0"));
  const response = await request("world/github/update/preview", {
    id: "test-world",
  });
  const update = await response.json();
  expect(update.status).toBe("available");
  expect(update.preview.changes.modified).toEqual(["world.yaml"]);
  expect(
    (
      await request("world/github/update", {
        token: update.preview.token,
        acceptRisk: true,
      })
    ).status,
  ).toBe(201);
  expect(await readFile(path.join(root, "test-world/world.yaml"), "utf8")).toBe(
    original,
  );
  await applyPendingPackageUpdates(root);
  await seedWorlds(store, root, lock);
  expect(
    JSON.parse(await readFile(path.join(root, "test-world/world.yaml"), "utf8"))
      .version,
  ).toBe("1.1.0");
  expect((await store.getWorld("test-world"))?.metadata).toMatchObject({
    packageManaged: true,
    source: "generated-file",
  });
  expect(
    (await (await request("worlds")).json()).items[0].pendingUpdate,
  ).toBeNull();
});
it("protects local file edits and editor changes, including after a seed refresh", async () => {
  await install();
  archive = await zip(files("test-world", "1.1.0"));
  const patch = await app.request("/api/worlds/test-world", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "My edited world" }),
  });
  expect(patch.status).toBe(200);
  expect(
    (await request("world/github/update/preview", { id: "test-world" })).status,
  ).toBe(409);
  await seedWorlds(store, root, lock);
  expect((await store.getWorld("test-world"))?.name).toBe("My edited world");
  await writeFile(path.join(root, "test-world/WORLD.md"), "Locally changed");
  expect(
    (await request("world/github/update/preview", { id: "test-world" })).status,
  ).toBe(409);
});
it("rechecks editor changes made after an update preview", async () => {
  await install();
  archive = await zip(files("test-world", "1.1.0"));
  const update = await (
    await request("world/github/update/preview", { id: "test-world" })
  ).json();
  const world = (await store.getWorld("test-world"))!;
  await store.upsertWorld({
    ...world,
    metadata: { ...world.metadata, packageModified: true },
  });
  expect(
    (
      await request("world/github/update", {
        token: update.preview.token,
        acceptRisk: true,
      })
    ).status,
  ).toBe(409);
});
