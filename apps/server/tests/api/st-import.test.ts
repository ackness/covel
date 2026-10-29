import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { stImportResultSchema } from "@covel/shared";
import { buildContext, buildSessionContextSnapshot } from "@covel/context";
import {
  discoverPluginAt,
  loadPluginDefinition,
  resolveRuntimePrompt,
} from "@covel/plugin-loader";
import { validateWorldPackage } from "../../src/world-data/validate-world-package.js";
import { installRoutes } from "../../src/routes/api/install.js";
import { worldRoutes } from "../../src/routes/api/worlds.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeErrorHandler } from "../../src/api-error.js";
import { createRequestBodyLimitMiddleware } from "../../src/middleware/request-body-limit.js";
import { makePng, v2Card, worldInfo } from "../helpers/st-card-fixtures.js";
import { readPngTextChunks } from "../../src/world-import/st/png-chunks.js";
let root: string;
let store: ReturnType<typeof createMemoryStore>;
let app: Hono;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "st-import-"));
  vi.stubEnv("COVEL_USER_WORLDS_DIR", root);
  store = createMemoryStore();
  app = new Hono();
  app.onError(makeErrorHandler("test", false));
  app.use("*", createRequestBodyLimitMiddleware());
  const sessionLock = createInProcessSessionLock();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("sessionLock", sessionLock);
    c.set("worldsDirs", [root]);
    await next();
  });
  app.route("/api/install", installRoutes);
  app.route("/api/worlds", worldRoutes);
});
afterEach(async () => {
  await store.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function post(
  values: unknown[] = [v2Card()],
  options: { preview?: boolean; locale?: string; name?: string } = {},
) {
  const form = new FormData();
  for (const [index, value] of values.entries()) {
    const bytes =
      value instanceof Uint8Array
        ? Buffer.from(value)
        : Buffer.from(JSON.stringify(value));
    form.append("file", new Blob([bytes]), `card${index}.json`);
  }
  if (options.preview) form.set("preview", "true");
  if (options.locale !== undefined) form.set("locale", options.locale);
  if (options.name !== undefined) form.set("name", options.name);
  return app.request("/api/install/st-import", { method: "POST", body: form });
}
async function narratorPrompt(worldId: string) {
  // Use the real dialogue-pack narrator template and the published world record.
  const discovery = await discoverPluginAt(
    path.resolve("../../plugins/chat-mode-narrator"),
  );
  if (!discovery) throw new Error("Narrator fixture missing");
  const definition = await loadPluginDefinition(discovery, "en-US");
  const runtime = definition.manifests.find(
    ({ manifest }) => manifest.outputKind === "story",
  );
  if (!runtime) throw new Error("Narrator fixture has no story runtime");
  const sessionId = "import-prompt-session";
  const sessionContext = await buildSessionContextSnapshot(store, sessionId, {
    worldId,
    locale: "en-US",
    turnNumber: 1,
    playerMessage: "Look around",
  });
  return buildContext({
    manifest: runtime.manifest,
    promptTemplate: resolveRuntimePrompt(runtime, "en-US"),
    sessionContext,
    completedResults: new Map(),
    turnInput: {
      sessionId,
      turnId: "first-turn",
      playerMessage: "Look around",
      origin: "player",
      locale: "en-US",
    },
    userSettings: Object.fromEntries(
      (runtime.manifest.userSettings ?? []).map((setting) => [
        setting.key,
        setting.default,
      ]),
    ),
  });
}
it("keeps omitted creator notes out of the published summary and assembled narrator prompt", async () => {
  const description = "Mira keeps a watchful eye on the island beacon.";
  const creatorNotes = "PRIVATE CREATOR GUIDANCE\n\nPRIVATE FOLLOW-UP GUIDANCE";
  const response = await post([
    v2Card({ description, creator_notes: creatorNotes }),
  ]);
  expect(response.status).toBe(201);
  const body = stImportResultSchema.parse(await response.json());
  expect(body.report.world.summary).toBe(description);
  expect(body.report.items).toContainEqual(
    expect.objectContaining({ code: "field-ignored", field: "creator_notes" }),
  );
  expect(await store.getWorld(body.id)).toMatchObject({ description });
  const assembled = await narratorPrompt(body.id);
  expect(assembled.systemPrompt).toContain(
    `<world-summary>\nName: Mira\nDescription: ${description}`,
  );
  expect(JSON.stringify(assembled)).not.toContain("PRIVATE CREATOR GUIDANCE");
  expect(JSON.stringify(assembled)).not.toContain("PRIVATE FOLLOW-UP GUIDANCE");
});
it.each([
  { label: "disabled", constant: true, disable: true },
  { label: "selective", constant: false, disable: false },
])(
  "keeps $label lore out of the unconditional narrator prompt",
  async ({ constant, disable }) => {
    const content = "The forbidden beacon hides a sleeping dragon.";
    const response = await post([
      worldInfo([{ key: ["beacon"], content, constant, disable }]),
    ]);
    expect(response.status).toBe(201);
    const body = stImportResultSchema.parse(await response.json());
    const assembled = await narratorPrompt(body.id);
    expect(assembled.systemPrompt).toContain("<world-lore>");
    expect(assembled.systemPrompt).toContain("## Premise\n\nIsland almanac");
    expect(JSON.stringify(assembled)).not.toContain(content);
  },
);
it("installs card plus lorebook with no world validation errors or receipt", async () => {
  const response = await post([v2Card(), worldInfo()]);
  expect(response.status).toBe(201);
  const body = stImportResultSchema.parse(await response.json());
  expect(body).toMatchObject({
    preview: false,
    id: "mira",
    restartRequired: false,
  });
  expect(await store.getWorld(body.id)).toMatchObject({ name: "Mira" });
  const directory = path.join(root, body.id);
  expect(await readdir(directory)).toEqual(
    expect.arrayContaining(["world.yaml", "WORLD.md", "characters", "data"]),
  );
  expect(await readdir(directory)).not.toContain(".covel-install.json");
  const validation = await validateWorldPackage({
    worldDir: directory,
    pluginsDirs: [path.resolve("../../plugins")],
  });
  expect(
    validation.diagnostics.filter((diagnostic) => diagnostic.level === "error"),
  ).toEqual([]);
});
it("uses a metadata-free PNG cover", async () => {
  const response = await post([makePng(v2Card())]);
  expect(response.status).toBe(201);
  expect(await readFile(path.join(root, "mira/world.yaml"), "utf8")).toContain(
    "cover: media/gallery/cover.png",
  );
  expect(
    readPngTextChunks(
      await readFile(path.join(root, "mira/media/gallery/cover.png")),
    ),
  ).toEqual([]);
});
it("previews without files or records", async () => {
  const response = await post(undefined, { preview: true });
  expect(response.status).toBe(200);
  expect(stImportResultSchema.parse(await response.json()).preview).toBe(true);
  expect(await readdir(root)).toEqual([]);
  expect(await store.getWorld("mira")).toBeNull();
});
it("rejects missing or non-file multipart fields", async () => {
  expect((await post([])).status).toBe(400);
  const form = new FormData();
  form.append("file", "text");
  expect(
    (
      await app.request("/api/install/st-import", {
        method: "POST",
        body: form,
      })
    ).status,
  ).toBe(400);
});
it.each([
  [Array.from({ length: 9 }, () => v2Card()), {}, 400, "files-limit"],
  [[Buffer.alloc(8 * 1024 * 1024 + 1)], {}, 413, "file-too-large"],
  [[Buffer.from("plain text")], {}, 400, "unsupported-file"],
  [[v2Card()], { locale: "!!!" }, 400, "locale-invalid"],
] as const)(
  "rejects invalid uploads with a stable code",
  async (files, options, status, code) => {
    const response = await post([...files], options);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ details: { code } });
    expect(await readdir(root)).toEqual([]);
  },
);
it("removes active HTML from every emitted file", async () => {
  const response = await post([
    v2Card({
      name: "<b>Mira</b>",
      description: "<script>alert(1)</script>safe",
      personality: "<iframe>bad</iframe>kind",
      scenario: "<svg>bad</svg>Harbor",
      character_book: {
        entries: [{ content: "<script>evil</script>lore", constant: true }],
      },
    }),
  ]);
  expect(response.status).toBe(201);
  async function inspect(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const target = path.join(directory, name);
      if ((await stat(target)).isDirectory()) await inspect(target);
      else
        expect(await readFile(target, "utf8")).not.toMatch(
          /<script|<iframe|<svg/i,
        );
    }
  }
  await inspect(path.join(root, "mira"));
});
it("chooses a fresh id for a second import", async () => {
  expect((await post()).status).toBe(201);
  const response = await post();
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ id: "mira-2" });
});
it("enforces the request body cap before parsing", async () => {
  const response = await app.request("/api/install/st-import", {
    method: "POST",
    headers: { "content-length": String(21 * 1024 * 1024) },
    body: "x",
  });
  expect(response.status).toBe(413);
  expect(await readdir(root)).toEqual([]);
});
it("checks on-disk id collisions even without a store record", async () => {
  await mkdir(path.join(root, "mira"));
  const response = await post(undefined, { preview: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: "mira-2" });
  expect(await readdir(root)).toEqual(["mira"]);
});
it("never overwrites another concurrent import", async () => {
  const results = await Promise.all([post(), post()]);
  const statuses = results.map((response) => response.status);
  // Advisory lookup may see either the reserved or already-published first id.
  expect(
    statuses.filter((status) => status === 201).length,
  ).toBeGreaterThanOrEqual(1);
  expect(statuses.every((status) => status === 201 || status === 409)).toBe(
    true,
  );
  expect(await readFile(path.join(root, "mira/world.yaml"), "utf8")).toContain(
    "name: Mira",
  );
});
