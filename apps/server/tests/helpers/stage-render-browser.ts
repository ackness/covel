import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import type { StageCastModel } from "@covel/shared";
import { createPluginAssetRoutes } from "../../src/routes/plugin-assets.js";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";
import { publicSessionIncarnation } from "../../src/routes/api/session/session-guard.js";
import { closeTestApi } from "./close-api.js";

interface StageRenderFixtureOptions {
  narration?: string;
  plugins?: readonly string[];
  beforeGenerate?: (call: number) => Promise<void>;
}

/** Real bundled projections and template loading, with deterministic story output. */
export async function createStageRenderFixture(
  options: StageRenderFixtureOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "covel-stage-render-"));
  const builtin = join(root, "plugins"),
    user = join(root, "user");
  await mkdir(join(builtin, "story-probe"), { recursive: true });
  await mkdir(user);
  for (const id of [
    "scene-stage",
    "character-blueprint",
    ...(options.plugins ?? []),
  ]) {
    await cp(
      resolve(import.meta.dirname, "../../../../plugins", id),
      join(builtin, id),
      { recursive: true },
    );
  }
  await writeFile(
    join(builtin, "story-probe", "PLUGIN.md"),
    `---
id: story-probe
description: Scripted public stage story
runtime:
  schedule: { stage: narrative }
  io:
    visibility: story
    output: { contract: narrative-engine@2 }
---
Tell the public scene story.
`,
  );
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    COVEL_USER_PLUGINS_DIR: process.env.COVEL_USER_PLUGINS_DIR,
    COVEL_DESKTOP_REST_TOKEN: process.env.COVEL_DESKTOP_REST_TOKEN,
  };
  process.env.NODE_ENV = "test";
  process.env.COVEL_USER_PLUGINS_DIR = user;
  delete process.env.COVEL_DESKTOP_REST_TOKEN;
  const store = createMemoryStore();
  const mediaStore = createMemoryMediaStore();
  let calls = 0;
  const start = async () => {
    const boot = await bootstrapApi({
      store,
      mediaStore,
      storeBackend: "memory",
      pluginsDir: builtin,
      pluginsDirs: [builtin, user],
      llmAdapter: {
        generate: async () => {
          const index = ++calls;
          await options.beforeGenerate?.(index);
          return {
            content: JSON.stringify({
              segments: [
                ...(options.narration
                  ? [{ kind: "narration", text: options.narration }]
                  : []),
                {
                  kind: "dialogue",
                  speaker: "Mira",
                  text: `Public dialogue ${index}.`,
                },
                {
                  kind: "dialogue",
                  speaker: "Unknown visitor",
                  text: "A readable line without a portrait.",
                },
              ],
              cues: {
                scene: "Library",
                present: index === 1 ? ["Mira", "Theo"] : ["Mira"],
              },
              yield: "user",
            }),
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
    boot.app.route("/", createPluginAssetRoutes(boot.registry));
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
    return boot;
  };
  let boot = await start();
  const world = await boot.app.request("/api/worlds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "stage-world",
      name: "Stage world",
      locale: "en-US",
    }),
  });
  if (!world.ok) throw new Error(await world.text());
  const response = await boot.app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      worldId: "stage-world",
      plugins: [
        "story-probe",
        "scene-stage",
        "character-blueprint",
        ...(options.plugins ?? []),
      ],
      autoAdvanceLimit: 0,
      locale: "en-US",
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const { id: sessionId } = (await response.json()) as { id: string };
  await store.updateSession(sessionId, { phase: "playing" });
  const at = new Date().toISOString();
  const seed = (
    pluginId: string,
    namespace: string,
    key: string,
    value: unknown,
  ) =>
    store.setPluginData({
      id: crypto.randomUUID(),
      sessionId,
      pluginId,
      namespace,
      key,
      value,
      createdAt: at,
      updatedAt: at,
    });
  for (const name of ["Mira", "Theo", "Cam", "Dev", "Eli"]) {
    await store.upsertCharacter({
      id: name.toLowerCase(),
      sessionId,
      name,
      type: "npc",
      fields: {},
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  }
  // Real owned bytes exercise authorization and integrity checks in Media.
  const portraitBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAIAAAD9b0jDAAAAJElEQVR4nGNIn3KC6ohh1NBRQ0cNHTV01NBRQ0cNHTV0ZBgKALWIZXxhJJC/AAAAAElFTkSuQmCC",
    "base64",
  );
  const avatar = await mediaStore.put(portraitBytes, "image/png");
  await mediaStore.recordOwnership(avatar.id, sessionId);
  await seed("character-blueprint", "presence", "mira", {
    schemaVersion: 1,
    characterId: "mira",
    displayName: "Mira",
    avatar,
  });
  await seed("scene-stage", "scenes", "scene-registry", {
    schemaVersion: 1,
    registryId: "fixture",
    scenes: [{ sceneId: "library", name: "Library", day: null, night: null }],
  });
  let revision = 0;
  return {
    get app() {
      return boot.app;
    },
    async restart() {
      await closeTestApi(boot);
      boot = await start();
    },
    avatar,
    sessionId,
    store,
    /** Deliver supported public snapshots through the real subscription transport. */
    async publishCast(value: StageCastModel) {
      const session = await store.getSession(sessionId);
      if (!session) throw new Error("Missing fixture session");
      boot.eventBus.emit({
        id: crypto.randomUUID(),
        type: "event",
        topic: "plugin",
        sessionId,
        sessionIncarnation: publicSessionIncarnation(session),
        timestamp: new Date().toISOString(),
        payload: {
          _subType: "ui.slot.changed",
          slot: "stage.cast@1",
          value,
          revision: `fixture-${++revision}`,
        },
      });
    },
    async close() {
      await closeTestApi(boot);
      await store.close();
      await rm(root, { recursive: true, force: true });
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** Bind the same fixture used by the browser to an isolated loopback host. */
export async function startStageRenderHost(
  options: StageRenderFixtureOptions = {},
) {
  const fixture = await createStageRenderFixture(options);
  const server = serve({
    fetch: (request) => fixture.app.fetch(request),
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
      get app() {
        return fixture.app;
      },
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
