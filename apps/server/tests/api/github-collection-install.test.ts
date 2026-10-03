import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { GithubCollectionPreview } from "@covel/shared";
import { installRoutes } from "../../src/routes/api/install.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

const repo = "https://github.com/example/pack";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const lock = createInProcessSessionLock();

function pluginFiles(id: string, directory = `plugins/${id}`) {
  return {
    [`${directory}/package.json`]: JSON.stringify({
      name: id,
      version: "1.0.0",
      type: "module",
    }),
    [`${directory}/PLUGIN.md`]: `---\nid: ${id}\nkind: plugin\ndescription: Synthetic check plugin\nprovides:\n  - action-check@1\n---\n`,
  };
}
function worldFiles(id = "barrow") {
  return {
    [`worlds/${id}/world.yaml`]: JSON.stringify({
      schemaVersion: "1.0",
      id,
      version: "1.0.0",
      name: { "en-US": "Barrow", "zh-CN": "古冢" },
      summary: "A tabletop world",
      defaultLocale: "en-US",
      supportedLocales: ["en-US", "zh-CN"],
      pluginPolicy: {
        requires: ["action-check@1"],
        requested: ["barrow-dice"],
      },
    }),
    [`worlds/${id}/WORLD.md`]: "A lantern has gone out.",
  };
}
const collection = (manifest: Record<string, unknown>) => ({
  "covel-collection.yaml": JSON.stringify({
    schemaVersion: 1,
    id: "barrow-pack",
    name: "Barrow Pack",
    version: "1.2.0",
    ...manifest,
  }),
});

async function zip(contents: Record<string, string>, prefix: string) {
  const file = new yazl.ZipFile();
  for (const [name, content] of Object.entries(contents))
    file.addBuffer(Buffer.from(content), `${prefix}/${name}`);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    file.outputStream.on("data", (chunk) => chunks.push(chunk));
    file.outputStream.on("error", reject);
    file.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  file.end();
  return result;
}

/** A ZIP with its files at the top level, as an uploaded package has them. */
async function zipRoot(contents: Record<string, string>) {
  const file = new yazl.ZipFile();
  for (const [name, content] of Object.entries(contents))
    file.addBuffer(Buffer.from(content), name);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    file.outputStream.on("data", (chunk) => chunks.push(chunk));
    file.outputStream.on("error", reject);
    file.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  file.end();
  return result;
}

let pluginRoot: string;
let worldRoot: string;
let app: Hono;
let store: ReturnType<typeof createMemoryStore>;
let archives: Record<string, Buffer>;

const request = (route: string, body: unknown) =>
  app.request(`/api/install/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
async function preview(): Promise<GithubCollectionPreview> {
  const response = await request("github/preview", { url: repo });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}
const exists = (target: string) =>
  lstat(target).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  pluginRoot = await mkdtemp(path.join(tmpdir(), "covel-pack-plugins-"));
  worldRoot = await mkdtemp(path.join(tmpdir(), "covel-pack-worlds-"));
  store = createMemoryStore();
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", pluginRoot);
  vi.stubEnv("COVEL_USER_WORLDS_DIR", worldRoot);
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("NODE_ENV", "test");
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("sessionLock", lock);
    c.set("worldsDirs", [worldRoot]);
    c.set("reservedPluginIds", new Set(["narrator"]));
    await next();
  });
  app.route("/api/install", installRoutes);
  archives = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/commits?")) return Response.json([{ sha }]);
      const match = /^https:\/\/codeload\.github\.com\/(.+)\/zip\/(\w+)$/.exec(
        url,
      );
      const archive = match && archives[`${match[1]}@${match[2]}`];
      if (archive) return new Response(new Uint8Array(archive));
      throw new Error(`Unexpected URL: ${url}`);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(pluginRoot, { recursive: true, force: true });
  await rm(worldRoot, { recursive: true, force: true });
});

describe("mixed GitHub previews and batch installs", () => {
  it("previews the plugins and worlds under one URL and installs them together", async () => {
    archives[`example/pack@${sha}`] = await zip(
      { ...pluginFiles("barrow-dice"), ...worldFiles() },
      "pack-commit",
    );

    const result = await preview();
    expect(result.collection).toBeNull();
    expect(result.items.map((item) => [item.kind, item.id])).toEqual([
      ["plugin", "barrow-dice"],
      ["world", "barrow"],
    ]);
    // The world's requirement is met by the plugin that ships beside it.
    expect(result.problems).toEqual([]);
    expect(await exists(path.join(pluginRoot, "barrow-dice"))).toBe(false);

    const response = await request("github/batch", {
      tokens: result.items.map((item) => item.token),
      acceptRisk: true,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      installed: [
        { kind: "plugin", id: "barrow-dice" },
        { kind: "world", id: "barrow" },
      ],
      restartRequired: true,
    });
    const receipt = JSON.parse(
      await readFile(
        path.join(pluginRoot, "barrow-dice", ".covel-install.json"),
        "utf8",
      ),
    );
    expect(receipt.source).toMatchObject({ repository: repo, commit: sha });
    expect(await store.getWorld("barrow")).toMatchObject({ id: "barrow" });
  });

  it("leaves out a package it cannot read and keeps the others installable", async () => {
    archives[`example/pack@${sha}`] = await zip(
      {
        ...pluginFiles("barrow-dice"),
        "examples/stale/package.json": JSON.stringify({ name: "stale" }),
        "examples/stale/PLUGIN.md":
          "---\nname: stale\npluginType: plugin\n---\n",
      },
      "pack-commit",
    );

    const result = await preview();

    expect(result.items.map((item) => item.id)).toEqual(["barrow-dice"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ level: "warning" });
    expect(result.problems[0]!.message).toContain("examples/stale is left out");
  });

  it("removes what the batch installed when a later package fails", async () => {
    archives[`example/pack@${sha}`] = await zip(
      { ...pluginFiles("barrow-dice"), ...worldFiles() },
      "pack-commit",
    );
    const result = await preview();
    vi.spyOn(store, "createWorld").mockRejectedValue(new Error("disk full"));

    const response = await request("github/batch", {
      tokens: result.items.map((item) => item.token),
      acceptRisk: true,
    });

    expect(response.status).toBe(500);
    expect(await exists(path.join(pluginRoot, "barrow-dice"))).toBe(false);
    expect(await exists(path.join(worldRoot, "barrow"))).toBe(false);
    expect(await store.getWorld("barrow")).toBeFalsy();
  });

  it("changes nothing when one package of the batch is already installed", async () => {
    archives[`example/pack@${sha}`] = await zip(
      { ...pluginFiles("barrow-dice"), ...worldFiles() },
      "pack-commit",
    );
    const result = await preview();
    await store.createWorld({
      id: "barrow",
      name: "Existing",
      description: "",
      createdAt: "2026-10-03T00:00:00.000Z",
    });

    const response = await request("github/batch", {
      tokens: result.items.map((item) => item.token),
      acceptRisk: true,
    });

    expect(response.status).toBe(409);
    expect(await exists(path.join(pluginRoot, "barrow-dice"))).toBe(false);
  });
});

describe("collection manifests", () => {
  it("installs what the manifest lists, pinned members included", async () => {
    archives[`example/pack@${sha}`] = await zip(
      {
        ...collection({
          worlds: [{ path: "worlds/barrow" }],
          plugins: [
            {
              repository: "example/dice",
              commit: otherSha,
              path: "plugins/barrow-dice",
            },
          ],
        }),
        ...worldFiles(),
        // Present in the repository but not listed: it is not offered.
        ...pluginFiles("unlisted"),
      },
      "pack-commit",
    );
    archives[`example/dice@${otherSha}`] = await zip(
      pluginFiles("barrow-dice"),
      "dice-commit",
    );

    const result = await preview();

    expect(result.collection).toEqual({
      id: "barrow-pack",
      name: "Barrow Pack",
      version: "1.2.0",
    });
    expect(result.items.map((item) => [item.kind, item.id])).toEqual([
      ["plugin", "barrow-dice"],
      ["world", "barrow"],
    ]);
    expect(result.items[0]!.source).toMatchObject({
      repository: "https://github.com/example/dice",
      commit: otherSha,
      tracking: { kind: "pinned", ref: otherSha },
    });
    expect(result.problems).toEqual([]);
  });

  it("says up front when the set is incomplete or written for another host version", async () => {
    archives[`example/pack@${sha}`] = await zip(
      {
        ...collection({
          covel: ">=99.0.0",
          worlds: [{ path: "worlds/barrow" }],
        }),
        ...worldFiles(),
      },
      "pack-commit",
    );

    const { problems } = await preview();

    expect(problems.map((item) => item.level)).toEqual([
      "error",
      "error",
      "warning",
    ]);
    expect(problems[0]!.message).toContain(">=99.0.0");
    expect(problems[1]!.message).toContain("action-check@1");
    expect(problems[2]!.message).toContain("barrow-dice");
  });

  it("refuses a plugin written for another host version before anything is offered", async () => {
    const files = pluginFiles("barrow-dice");
    files["plugins/barrow-dice/PLUGIN.md"] = files[
      "plugins/barrow-dice/PLUGIN.md"
    ]!.replace("kind: plugin\n", 'kind: plugin\ncovel: ">=99.0.0"\n');
    archives[`example/pack@${sha}`] = await zip(files, "pack-commit");

    const response = await request("github/preview", { url: repo });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("barrow-dice needs Covel >=99.0.0");
    expect(text).toContain("this host runs");
  });

  it("rejects a manifest that does not pin an external member", async () => {
    archives[`example/pack@${sha}`] = await zip(
      collection({
        plugins: [{ repository: "example/dice", commit: "main" }],
      }),
      "pack-commit",
    );

    const response = await request("github/preview", { url: repo });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("40-character commit SHA");
  });
});

describe("collection ZIP import", () => {
  const upload = async (contents: Record<string, string>) => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await zipRoot(contents))]),
      "pack.zip",
    );
    return app.request("/api/install/collection", {
      method: "POST",
      body: form,
    });
  };

  it("installs a packed collection as a unit", async () => {
    const response = await upload({
      ...collection({
        worlds: [{ path: "worlds/barrow" }],
        plugins: [{ path: "plugins/barrow-dice" }],
      }),
      ...pluginFiles("barrow-dice"),
      ...worldFiles(),
    });

    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({
      installed: [
        { kind: "plugin", id: "barrow-dice" },
        { kind: "world", id: "barrow" },
      ],
      restartRequired: true,
    });
    expect(
      await exists(path.join(pluginRoot, "barrow-dice", "PLUGIN.md")),
    ).toBe(true);
    expect(await store.getWorld("barrow")).toMatchObject({ id: "barrow" });
  });

  it("writes nothing when the packed set is incomplete", async () => {
    const response = await upload({
      ...collection({ worlds: [{ path: "worlds/barrow" }] }),
      ...worldFiles(),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("requires action-check@1");
    expect(await exists(path.join(worldRoot, "barrow"))).toBe(false);
    expect(await store.getWorld("barrow")).toBeFalsy();
  });
});
