import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yazl from "yazl";
import { createMemoryStore } from "@covel/store/memory";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { installRoutes } from "../../src/routes/api/install.js";
import { loadSingleWorld, seedWorlds } from "../../src/world-seed-loader.js";

const id = "world-data-install-probe";
const manifest = `schemaVersion: "1.0"
id: ${id}
name: Synthetic World
summary: World data install validation fixture.
defaultLocale: en-US
worldData: data/world.data.yaml
`;
const descriptor = `schemaVersion: 1
sources:
  probe:
    kind: json
    path: data/probe.json
    schema: data/probe.schema.json
    to: world:metadata.probe
`;
const validEntries = {
  "world.yaml": manifest,
  "WORLD.md": "# Synthetic lore\n",
  "data/world.data.yaml": descriptor,
  "data/probe.json": JSON.stringify({ title: "Valid" }),
  "data/probe.schema.json": JSON.stringify({
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  }),
};

async function zipBuffer(entries: Record<string, string>) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries))
    zip.addBuffer(Buffer.from(content), name);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
    zip.end();
  });
}

async function upload(app: Hono, entries: Record<string, string>) {
  const buffer = await zipBuffer(entries);
  const form = new FormData();
  form.append("file", new Blob([buffer]), "synthetic.zip");
  return app.request("/api/install/world", { method: "POST", body: form });
}

let root: string;
let worlds: string;
let store: ReturnType<typeof createMemoryStore>;
let app: Hono;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-world-data-install-"));
  worlds = path.join(root, "worlds");
  await mkdir(worlds);
  vi.stubEnv("COVEL_USER_WORLDS_DIR", worlds);
  vi.stubEnv("COVEL_HOME", path.join(root, "home"));
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  store = createMemoryStore();
  app = new Hono();
  const lock = createInProcessSessionLock();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("sessionLock", lock);
    await next();
  });
  app.route("/api/install", installRoutes);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await store.close();
  await rm(root, { recursive: true, force: true });
});

describe("world ZIP activation worldData validation", () => {
  it.each([
    ["missing descriptor", "data/world.data.yaml", undefined, "descriptor"],
    [
      "malformed descriptor",
      "data/world.data.yaml",
      "sources: [",
      "descriptor",
    ],
    ["missing source", "data/probe.json", undefined, "probe"],
    ["malformed JSON source", "data/probe.json", "{", "probe"],
    ["malformed YAML source", "data/probe.json", "title: [", "probe"],
    [
      "own schema mismatch",
      "data/probe.json",
      '{"title":42}',
      "schema validation",
    ],
    ["missing own schema", "data/probe.schema.json", undefined, "schema"],
  ])(
    "rejects %s, cleans up and permits a repaired same-ID retry",
    async (label, file, content, diagnostic) => {
      const entries: Record<string, string> = { ...validEntries };
      if (content === undefined) delete entries[file];
      else entries[file] = content;
      if (label === "malformed YAML source")
        entries["data/world.data.yaml"] = descriptor.replace(
          "kind: json",
          "kind: yaml",
        );
      const response = await upload(app, entries);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(diagnostic);
      expect(await store.getWorld(id)).toBeNull();
      await expect(access(path.join(worlds, id))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await upload(app, validEntries)).status).toBe(201);
      expect(await store.getWorld(id)).not.toBeNull();
      expect(
        await readFile(path.join(worlds, id, "data/probe.json"), "utf8"),
      ).toBe(validEntries["data/probe.json"]);
    },
  );

  it("allows warnings and does not execute packaged code", async () => {
    const response = await upload(app, {
      ...validEntries,
      "server.js": 'throw new Error("Packaged code must never execute");',
    });
    expect(response.status).toBe(201);
    const record = await store.getWorld(id);
    expect(record?.metadata?.worldData).toMatchObject({
      sources: [{ id: "probe", diagnostics: { error: 0, warning: 1 } }],
    });
  });

  it("does not let a local override hide the shipped source schema mismatch", async () => {
    const overrideDir = path.join(root, "home", "world-overrides", id);
    await mkdir(overrideDir, { recursive: true });
    await writeFile(
      path.join(overrideDir, "world.data.override.yaml"),
      `schemaVersion: 1\nsources:\n  probe:\n    path: repaired.json\n`,
    );
    await writeFile(
      path.join(overrideDir, "repaired.json"),
      validEntries["data/probe.json"],
    );
    const response = await upload(app, {
      ...validEntries,
      "data/probe.json": '{"title":42}',
    });
    expect(response.status).toBe(400);
    expect(await store.getWorld(id)).toBeNull();
    await expect(access(path.join(worlds, id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves existing records and files when an install attempts replacement", async () => {
    expect((await upload(app, validEntries)).status).toBe(201);
    const before = await store.getWorld(id);
    const response = await upload(app, {
      ...validEntries,
      "data/probe.json": "{",
    });
    expect(response.status).toBe(409);
    expect(await store.getWorld(id)).toEqual(before);
    expect(
      await readFile(path.join(worlds, id, "data/probe.json"), "utf8"),
    ).toBe(validEntries["data/probe.json"]);
  });

  it("rejects an invalid update preview without changing the installed package and permits a repaired retry", async () => {
    const request = (route: string, body: unknown) =>
      app.request(`/api/install/world/github${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const archiveOf = (entries: Record<string, string>) =>
      zipBuffer(
        Object.fromEntries(
          Object.entries(entries).map(([file, content]) => [
            `synthetic-commit/worlds/${id}/${file}`,
            content,
          ]),
        ),
      );
    let archive = await archiveOf(validEntries);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/commits?"))
          return Response.json([{ sha: "a".repeat(40) }]);
        if (url.startsWith("https://codeload.github.com/"))
          return new Response(new Uint8Array(archive));
        throw new Error(`Unexpected fixture URL: ${url}`);
      }),
    );
    const preview = await request("/preview", {
      url: "https://github.com/example/synthetic-worlds",
    });
    expect(preview.status).toBe(200);
    const { items } = await preview.json();
    expect(
      (await request("", { token: items[0].token, acceptRisk: true })).status,
    ).toBe(201);
    const before = await store.getWorld(id);
    archive = await archiveOf({
      ...validEntries,
      "data/probe.json": '{"title":42}',
    });
    expect((await request("/update/preview", { id })).status).toBe(400);
    expect(await store.getWorld(id)).toEqual(before);
    expect(
      await readFile(path.join(worlds, id, "data/probe.json"), "utf8"),
    ).toBe(validEntries["data/probe.json"]);
    await expect(
      access(path.join(worlds, ".covel-updates", id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    archive = await archiveOf({
      ...validEntries,
      "data/probe.json": '{"title":"Repaired"}',
    });
    const retry = await request("/update/preview", { id });
    expect(retry.status).toBe(200);
    expect((await retry.json()).status).toBe("available");
  });

  it("keeps startup seed tolerant of worldData errors", async () => {
    const directory = path.join(worlds, id);
    await mkdir(directory);
    await writeFile(path.join(directory, "world.yaml"), manifest);
    await writeFile(path.join(directory, "WORLD.md"), "# Synthetic lore\n");
    expect(await loadSingleWorld(directory)).not.toBeNull();
    expect(
      await seedWorlds(store, worlds, createInProcessSessionLock()),
    ).toEqual({ worldIds: [id], complete: true });
    expect(await store.getWorld(id)).not.toBeNull();
  });
});
