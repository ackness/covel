import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { WorldPluginPlan } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
import { closeTestApi } from "../helpers/close-api.js";

const project = path.resolve(import.meta.dirname, "../../../..");

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "covel-narrative-setup-"));
  const store = createMemoryStore();
  const boot = await bootstrapApi({
    pluginsDir: path.join(project, "plugins"),
    pluginsDirs: [path.join(project, "plugins")],
    worldsDirs: [path.join(project, "worlds")],
    covelHome: root,
    store,
    storeBackend: "memory",
    llmAdapter: {
      generate: async (request) => {
        const facts = request.tools?.find(
          (tool) => tool.name === "submit-world-facts",
        );
        return {
          content: JSON.stringify({
            segments: [
              { kind: "narration", text: "The lantern lights the path." },
            ],
            cues: { present: [] },
          }),
          toolCalls: facts
            ? [
                {
                  id: "facts",
                  name: facts.name,
                  arguments: JSON.stringify({
                    schemaVersion: 1,
                    summary: "The lantern lights the path.",
                    entities: [],
                    relations: [],
                    events: [],
                    statements: [],
                    objectiveAssessments: [],
                  }),
                },
              ]
            : [],
          finishReason: facts ? "tool_calls" : "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });
  const post = (url: string, body: unknown) =>
    boot.app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    store,
    boot,
    post,
    async create(worldId: string, explicitSetup = false) {
      const world = await loadSingleWorld(
        path.join(project, "worlds", worldId),
      );
      if (!world) throw new Error(`Missing bundled world: ${worldId}`);
      await store.upsertWorld(world);
      const response = await boot.app.request(
        `/api/worlds/${worldId}/plugin-plan`,
      );
      expect(response.status).toBe(200);
      const plan = (await response.json()) as WorldPluginPlan;
      const pack = plan.packs.find((pack) => pack.id === "narrative-only");
      if (!pack) throw new Error("Missing narrative composition");
      const created = await post("/api/sessions", {
        id: "session",
        worldId,
        plugins: [
          ...pack.requested,
          ...plan.selection.requestedPluginIds,
          ...(explicitSetup ? ["tabletop-rules"] : []),
        ],
        excludedPlugins: pack.excluded,
      });
      expect(created.status, await created.clone().text()).toBe(201);
      return created;
    },
    async start() {
      const response = await post("/api/actions", {
        requestId: crypto.randomUUID(),
        sessionId: "session",
        type: "start_session",
        payload: {},
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return body;
    },
    async close() {
      await closeTestApi(boot);
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.each(["lantern-barrow", "mistport", "haruka-academy", "emberback"])(
  "begins a narrative-only adventure in %s without inferred setup",
  async (worldId) => {
    const h = await harness();
    try {
      const created = await h.create(worldId);
      if (worldId === "lantern-barrow")
        expect(await created.json()).toMatchObject({
          worldDataNotices: expect.arrayContaining([
            expect.objectContaining({ code: "receiver-missing" }),
          ]),
        });
      await h.start();
      const session = await h.store.getSession("session");
      expect(session?.phase).toBe("playing");
      expect(session?.completedPlayerTurns).toBe(0);
      expect(session?.activePlugins).not.toContain("tabletop-rules");
      expect(
        (await h.store.listTurnResults("session")).at(-1)?.commitStatus,
      ).toBe("committed");
      expect(await h.store.listTurnMessages("session")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: "The lantern lights the path.",
          }),
        ]),
      );
      const response = await h.post("/api/actions", {
        requestId: crypto.randomUUID(),
        sessionId: "session",
        type: "submit_actions",
        payload: { actions: [{ kind: "say", text: "I lift the lantern." }] },
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect((await h.store.getSession("session"))?.completedPlayerTurns).toBe(
        1,
      );
      expect(
        (await h.store.listTurnResults("session")).at(-1)?.commitStatus,
      ).toBe("committed");
    } finally {
      await h.close();
    }
  },
);

it("keeps enabled unfinished setup pending and can open after its plugin is disabled", async () => {
  const h = await harness();
  try {
    await h.create("lantern-barrow", true);
    const body = await h.start();
    expect(body).toContain('"reason":"no-eligible-story"');
    const session = await h.store.getSession("session");
    expect(session?.phase).toBe("setup");
    expect(session?.completedPlayerTurns).toBe(0);
    expect(session?.setupRuntimes["tabletop-rules/creation"]).toMatchObject({
      state: "pending",
      attempts: 1,
    });
    expect(await h.store.listTurnMessages("session")).toEqual([]);
    const disabled = await h.boot.app.request(
      "/api/sessions/session/plugins/tabletop-rules",
      { method: "DELETE" },
    );
    expect(disabled.status, await disabled.text()).toBe(200);
    await h.start();
    const playable = await h.store.getSession("session");
    expect(playable?.phase).toBe("playing");
    expect(playable?.completedPlayerTurns).toBe(0);
    // Disabling removes the feature, without inventing a completion signal.
    expect(playable?.setupRuntimes["tabletop-rules/creation"]?.state).toBe(
      "pending",
    );
    expect(
      (await h.store.listTurnResults("session")).at(-1)?.commitStatus,
    ).toBe("committed");
  } finally {
    await h.close();
  }
});
