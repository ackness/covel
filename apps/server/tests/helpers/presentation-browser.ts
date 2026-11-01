import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listRuntimeJobs } from "../../src/routes/api/plugin-rpc/jobs.js";
import { serve } from "@hono/node-server";
import { createMemoryStore, createMemoryMediaStore } from "@covel/store/memory";
import { AiProviderError } from "@covel/ai-provider";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";
import { closeTestApi } from "./close-api.js";

/** The browser fixture's API, also exercised without sockets by its boot regression. */
export async function createPresentationBrowserFixture(
  outcome: "updated" | "exhausted" | "failed" = "updated",
  options: {
    failInline?: boolean;
    budgetCalls?: number;
    yields?: readonly ("continue" | "user")[];
    autoAdvanceLimit?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "covel-presentation-browser-"));
  const builtin = join(root, "plugins"),
    user = join(root, "user");
  await mkdir(join(builtin, "story-probe"), { recursive: true });
  await mkdir(user);
  await writeFile(
    join(builtin, "story-probe", "PLUGIN.md"),
    `---
id: story-probe
description: Scripted public presentation story
runtime:
  schedule: { stage: narrative }
  io:
    visibility: story
    output: { contract: narrative-engine@2 }
---
Tell a public scene story.
`,
  );
  const original = {
    node: process.env.NODE_ENV,
    user: process.env.COVEL_USER_PLUGINS_DIR,
    token: process.env.COVEL_DESKTOP_REST_TOKEN,
  };
  process.env.NODE_ENV = "test";
  process.env.COVEL_USER_PLUGINS_DIR = user;
  delete process.env.COVEL_DESKTOP_REST_TOKEN;
  const store = createMemoryStore();
  const mediaStore = createMemoryMediaStore();
  let calls = 0;
  const mediaCalls: string[] = [];
  const gate = Promise.withResolvers<void>();
  for (const id of ["scene-stage", "soundtrack"])
    await cp(
      resolve(import.meta.dirname, "../../../../plugins", id),
      join(builtin, id),
      { recursive: true },
    );
  if (options.failInline) {
    for (const id of ["scene-stage", "soundtrack"]) {
      const file = join(builtin, id, "runtimes/story-cues/handler.js");
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace(
          "export default async function handler(ctx) {",
          'let first = true;\nexport default async function handler(ctx) {\nif (first) { first = false; throw new Error("Selector unavailable"); }',
        ),
      );
    }
  }
  await mkdir(join(builtin, "presentation-probe"));
  await writeFile(
    join(builtin, "presentation-probe", "PLUGIN.md"),
    `---
id: presentation-probe
description: Generates owned display text from a public scene.
contributes:
  ui:
    right: [./display.json]
runtime:
  schedule: { stage: post-turn, detached: true }
  presentation: { budget: { calls: ${options.budgetCalls ?? 1} } }
  io:
    inputs:
      story: { from: { contract: narrative-engine@2 }, required: false }
  function: { handler: ./handler.mjs, model: plugin }
  effects:
    reads: [plugin-data:self:display]
    writes: [plugin-data:self:display]
---
`,
  );
  await writeFile(
    join(builtin, "presentation-probe", "handler.mjs"),
    `export default async function(ctx) {
    const story = ctx.inputs?.story?.value;
    if (!story) { ctx.presentation.note("no-story"); return { outcome: "success", value: {} }; }
    const generated = await ctx.gateway.generateText({ prompt: JSON.stringify(story) });
    await ctx.pluginData.set("display", "current", { title: generated.text, source: "Source: " + story.segments[0].text });
    ${outcome === "exhausted" ? 'await ctx.gateway.generateText({ prompt: "Another public scene" });' : ""}
    return { outcome: "success", value: {} };
  }`,
  );
  await writeFile(
    join(builtin, "presentation-probe", "display.json"),
    JSON.stringify({
      id: "generated-display",
      label: "Public story display",
      surfaces: ["stage"],
      dataSource: { namespace: "display" },
      emptyState: { message: "No generated display" },
      view: {
        component: "Stack",
        children: [
          {
            component: "Text",
            props: { content: { $state: "/current/title" } },
          },
          {
            component: "Text",
            props: { content: { $state: "/current/source" } },
          },
        ],
      },
    }),
  );
  const boot = await bootstrapApi({
    store,
    mediaStore,
    storeBackend: "memory",
    pluginsDir: builtin,
    pluginsDirs: [builtin, user],
    canRunRuntimeJobWithServerServices: () => true,
    pluginGateway: {
      resolveSlot: () => ({
        presetId: "plugin",
        provider: "fixture",
        model: "text",
        protocol: "openai-chat-v1",
        tag: "text",
        metadata: {},
      }),
      generateText: async (input) => {
        mediaCalls.push(input.prompt ?? "");
        await gate.promise;
        input.signal?.throwIfAborted();
        if (outcome === "failed")
          throw new AiProviderError({
            code: "PROVIDER_ERROR",
            provider: "fixture",
            message: "Scripted provider failure",
            retriable: false,
          });
        return {
          text: "Generated display",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      generateObject: async <T>() => ({
        object: {} as T,
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    },
    llmAdapter: {
      generate: async () => {
        const index = ++calls;
        return {
          content: JSON.stringify({
            segments: [
              { kind: "narration", text: `Public library story ${index}.` },
            ],
            cues: { scene: "Library", mood: "Tense", present: ["Mira"] },
            yield: options.yields?.[index - 1] ?? "user",
          }),
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });
  // bootstrapApi supplies game routes; the application normally mounts these
  // additional boot routes. The scripted adapter has no configured presets.
  boot.app.get("/api/presets", (c) => c.json({ items: [] }));
  boot.app.get("/api/llm-config", (c) =>
    c.json({ configured: false, slots: {}, providers: [] }),
  );
  boot.app.get("/api/ui-specs", async (c) =>
    c.json(
      await buildUiSpecsResponse({
        registry: boot.registry,
        store: boot.store,
        sessionId: c.req.query("sessionId"),
      }),
    ),
  );
  const world = await boot.app.request("/api/worlds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "presentation-world",
      name: "Presentation world",
      locale: "en-US",
    }),
  });
  if (!world.ok) throw new Error(await world.text());
  const response = await boot.app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      worldId: "presentation-world",
      plugins: [
        "story-probe",
        "scene-stage",
        "soundtrack",
        "presentation-probe",
      ],
      autoAdvanceLimit: options.autoAdvanceLimit ?? 0,
      locale: "en-US",
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const session = (await response.json()) as { id: string };
  await store.updateSession(session.id, { phase: "playing" });
  const at = new Date().toISOString();
  const seed = async (
    pluginId: string,
    namespace: string,
    key: string,
    value: unknown,
  ) =>
    store.setPluginData({
      id: crypto.randomUUID(),
      sessionId: session.id,
      pluginId,
      namespace,
      key,
      value,
      createdAt: at,
      updatedAt: at,
    });
  await store.upsertCharacter({
    id: "mira",
    sessionId: session.id,
    name: "Mira",
    type: "npc",
    fields: {},
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const backdrop = await mediaStore.put(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
  );
  await mediaStore.recordOwnership(backdrop.id, session.id, "scene-stage");
  await mediaStore.addRef(backdrop.id, session.id, "scene-stage");
  const wave = Buffer.alloc(44 + 1600);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(1600, 40);
  const music = await mediaStore.put(wave, "audio/wav");
  await mediaStore.recordOwnership(music.id, session.id, "soundtrack");
  await mediaStore.addRef(music.id, session.id, "soundtrack");
  await seed("scene-stage", "scenes", "scene-registry", {
    schemaVersion: 1,
    registryId: "fixture",
    scenes: [
      { sceneId: "library", name: "Library", day: backdrop, night: null },
    ],
  });
  await seed("soundtrack", "tracks", "music-registry", {
    schemaVersion: 1,
    registryId: "music-registry",
    tracks: [
      {
        id: "library",
        title: "Library tension",
        file: "library.wav",
        moods: ["Tense"],
      },
    ],
  });
  await seed("soundtrack", "assets", "library.wav", { ref: music });

  return {
    app: boot.app,
    sessionId: session.id,
    store,
    calls: () => calls,
    mediaCalls,
    backdrop,
    music,
    jobs: () => listRuntimeJobs(store, { sessionId: session.id }),
    release() {
      gate.resolve();
    },
    async close() {
      gate.resolve();
      await closeTestApi(boot);
      await store.close();
      await rm(root, { recursive: true, force: true });
      for (const [key, value] of Object.entries({
        NODE_ENV: original.node,
        COVEL_USER_PLUGINS_DIR: original.user,
        COVEL_DESKTOP_REST_TOKEN: original.token,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** An isolated HTTP host for the real browser's session and streaming requests. */
export async function startPresentationBrowserHost(
  outcome: "updated" | "exhausted" | "failed" = "updated",
) {
  const fixture = await createPresentationBrowserFixture(outcome);
  const server = serve({
    fetch: fixture.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
  });
  try {
    if (!server.listening)
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test host address");
    return {
      ...fixture,
      baseUrl: `http://127.0.0.1:${address.port}`,
      async close() {
        await fixture.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
