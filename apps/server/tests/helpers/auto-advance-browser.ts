import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";
import { closeTestApi } from "./close-api.js";

/** The browser fixture's API, also exercised without sockets by its boot regression. */
export async function createAdvancementBrowserFixture() {
  const root = await mkdtemp(join(tmpdir(), "covel-advance-browser-"));
  const builtin = join(root, "plugins"),
    user = join(root, "user");
  await mkdir(join(builtin, "story-probe"), { recursive: true });
  await mkdir(user);
  await writeFile(
    join(builtin, "story-probe", "PLUGIN.md"),
    `---
id: story-probe
description: Scripted advancement story
runtime:
  schedule: { stage: narrative }
  io:
    visibility: story
    output: { contract: narrative-engine@2 }
---
Tell a short story.
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
  let calls = 0;
  let holdAt: number | undefined;
  let gate = Promise.withResolvers<void>();
  const boot = await bootstrapApi({
    store,
    storeBackend: "memory",
    pluginsDir: builtin,
    pluginsDirs: [builtin, user],
    llmAdapter: {
      generate: async (request) => {
        const index = ++calls;
        if (index === holdAt)
          await Promise.race([
            gate.promise,
            new Promise<void>((_, reject) => {
              const abort = () =>
                reject(new DOMException("Stopped", "AbortError"));
              if (request.signal?.aborted) abort();
              else
                request.signal?.addEventListener("abort", abort, {
                  once: true,
                });
            }),
          ]);
        return {
          content: JSON.stringify({
            segments: [{ kind: "narration", text: `Saved scene ${index}.` }],
            yield: "continue",
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
      id: "advance-world",
      name: "Advancement world",
      locale: "en-US",
    }),
  });
  if (!world.ok) throw new Error(await world.text());
  const response = await boot.app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      worldId: "advance-world",
      plugins: ["story-probe"],
      autoAdvanceLimit: 2,
      locale: "en-US",
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const session = (await response.json()) as { id: string };
  await store.updateSession(session.id, { phase: "playing" });
  return {
    app: boot.app,
    sessionId: session.id,
    store,
    calls: () => calls,
    holdNextAuto() {
      holdAt = calls + 2;
      gate = Promise.withResolvers<void>();
    },
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
export async function startAdvancementBrowserHost() {
  const fixture = await createAdvancementBrowserFixture();
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
