import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";
import { parseJsonFrames } from "../api/sse-test-utils.js";

it("boots without plugins and handles a world with dimensions without a server error", async () => {
  const pluginsDir = await mkdtemp(path.join(tmpdir(), "covel-empty-plugins-"));
  const store = createMemoryStore();
  const generate = vi.fn(() => {
    throw new Error("An empty plugin pool must never call a model");
  });
  let api: Awaited<ReturnType<typeof bootstrapApi>> | undefined;
  try {
    api = await bootstrapApi({
      pluginsDir,
      pluginsDirs: [pluginsDir],
      store,
      storeBackend: "memory",
      llmAdapter: { generate },
    });
    expect(api.registry.getAll().size).toBe(0);
    expect((await api.app.request("/api/health")).status).toBe(200);
    const dimensions = {
      stamina: {
        name: "Stamina",
        schema: { type: "integer", minimum: 0 },
        initialValue: 3,
      },
    };
    await store.createWorld({
      id: "empty-pool-world",
      name: "World without plugins",
      description: "Dimensions remain authored data without a provider.",
      metadata: { dimensions },
      createdAt: new Date().toISOString(),
    });
    const app = api.app;
    const post = (url: string, body: unknown) =>
      app.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await post("/api/sessions", {
      worldId: "empty-pool-world",
      plugins: [],
    });
    expect(created.status).toBe(201);
    const session = await created.json();
    expect(session).toMatchObject({
      activePlugins: [],
      phase: "playing",
      ignoredDimensions: ["stamina"],
    });

    // This is the API's existing notice for an empty selection. The web's
    // localized "no narrative plugin" text is not an API response field.
    const start = await post("/api/actions", {
      requestId: crypto.randomUUID(),
      sessionId: session.id,
      type: "start_session",
      payload: {},
    });
    expect(start.status).toBe(400);
    expect(await start.json()).toMatchObject({
      code: "no_active_plugins",
      error:
        "Session has no active plugins. Create the session with an explicit plugin set (or a world whose manifest seeds one) before starting it.",
    });

    const turn = await post("/api/actions", {
      requestId: crypto.randomUUID(),
      sessionId: session.id,
      type: "send_message",
      payload: { content: "Look around." },
    });
    expect(turn.status).toBe(200);
    const events = parseJsonFrames<{
      type: string;
      payload: Record<string, unknown>;
    }>(await turn.text());
    expect(
      events.find((event) => event.type === "execution.completed"),
    ).toMatchObject({
      payload: { runtimeCount: 0, resultCount: 0, committed: true },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "error.occurred" || event.type === "runtime.failed",
      ),
    ).toEqual([]);
    expect(
      (await store.getWorld("empty-pool-world"))?.metadata?.dimensions,
    ).toEqual(dimensions);
    expect((await store.getSession(session.id))?.completedPlayerTurns).toBe(1);
    expect(generate).not.toHaveBeenCalled();
  } finally {
    await closeTestApi(api);
    await store.close();
    await rm(pluginsDir, { recursive: true, force: true });
  }
});
