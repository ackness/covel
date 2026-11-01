import { submittedOutput } from "../helpers/output-submission.js";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";
import { registerTestPlugins } from "../helpers/register-test-plugins.js";
import { __resetUiSpecsCache } from "../../src/routes/misc-api/ui-specs.js";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));

afterEach(__resetUiSpecsCache);

describe("active bundled views", () => {
  it("discovers real zero-runtime and data views, removes only disabled providers, and performs no gameplay work", async () => {
    const registry = createPluginRegistry();
    await registerTestPlugins(registry, [
      path.resolve(import.meta.dirname, "../../../../plugins"),
    ]);
    const store = createMemoryStore();
    const generate = vi.fn();
    const stubAi = {
      presetRegistry: { listPresets: () => [] },
      gateway: { generate },
    } as unknown as Parameters<typeof createMiscApiRoutes>[0];
    const app = createMiscApiRoutes(stubAi, registry, store);
    const activePlugins = [
      "dm-console",
      "npc-graph",
      "codex",
      "world-ir",
      "narrator",
    ];
    await store.createSession({
      id: "s",
      status: "active",
      phase: "playing",
      locale: "en-US",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      seats: [
        { id: "host", controller: "human", role: "host", characters: [] },
      ],
      activePlugins,
      createdAt: "2026-10-31",
      updatedAt: "2026-10-31",
    });
    const writes = vi.spyOn(store, "setPluginData");
    async function read() {
      const response = await app.request("/api/ui-specs?sessionId=s");
      expect(response.status).toBe(200);
      return (await response.json()) as {
        view: { pluginId: string; specs: { id: string }[] }[];
        right: { pluginId: string }[];
        diagnostics: unknown[];
      };
    }
    const result = await read();
    expect(result.diagnostics).toEqual([]);
    expect(
      result.view.map((entry) => [
        entry.pluginId,
        entry.specs.map((spec) => spec.id),
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["dm-console", ["dm-console"]],
        ["npc-graph", ["relationships"]],
        ["codex", ["library"]],
      ]),
    );
    expect(result.right.map((entry) => entry.pluginId)).toEqual(
      expect.arrayContaining(["npc-graph", "codex"]),
    );
    expect(registry.get("dm-console")?.manifests).toEqual([]);
    await store.updateSession("s", {
      activePlugins: activePlugins.filter((id) => id !== "npc-graph"),
    });
    const disabled = await read();
    expect(disabled.view.map((entry) => entry.pluginId)).toEqual(
      expect.arrayContaining(["dm-console", "codex"]),
    );
    expect(disabled.view.some((entry) => entry.pluginId === "npc-graph")).toBe(
      false,
    );
    expect(disabled.right.some((entry) => entry.pluginId === "npc-graph")).toBe(
      false,
    );
    expect(generate).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });
});

it("commits host Direct and textless Advance through normal actions while refusing forged authority", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { bootstrapApi } = await import("../../src/routes/api/bootstrap.js");
  const { closeTestApi } = await import("../helpers/close-api.js");
  const user = await mkdtemp(path.join(tmpdir(), "console-actions-"));
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "console-test-token");
  const store = createMemoryStore();
  const generate = vi.fn(async () =>
    submittedOutput(
      {
        segments: [{ kind: "narration", text: "A public bell rings." }],
        yield: "user",
      },
      { inputTokens: 1, outputTokens: 1 },
    ),
  );
  const root = path.resolve(import.meta.dirname, "../../../../plugins");
  const boot = await bootstrapApi({
    pluginsDir: root,
    pluginsDirs: [root, user],
    store,
    storeBackend: "memory",
    llmAdapter: { generate },
    canRunRuntimeJobWithServerServices: () => true,
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer console-test-token",
  };
  try {
    await store.createWorld({
      id: "bell-world",
      name: "Bell room",
      description: "A public room with a bell.",
      locale: "en-US",
      metadata: { pluginSettings: { narrator: { perspective: "dm" } } },
      createdAt: "2026-10-31",
    });
    const created = await boot.app.request("/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        worldId: "bell-world",
        locale: "en-US",
        seatRole: "host",
        plugins: ["narrator", "dm-console"],
        excludedPlugins: [
          "pregame",
          "world-init",
          "char-creator",
          "world-time",
          "memory",
          "history-compaction",
        ],
      }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string };
    await store.updateSession(session.id, { phase: "playing" });
    const post = (action: Record<string, unknown>) =>
      boot.app.request("/api/actions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          sessionId: session.id,
          type: "submit_actions",
          payload: { actions: [action] },
        }),
      });
    for (const action of [
      { kind: "direct", seatId: "main", text: "Ring the bell." },
      { kind: "advance", seatId: "main" },
    ]) {
      const response = await post(action);
      expect(response.status).toBe(200);
      const wire = await response.text();
      expect(wire).toContain("A public bell rings.");
      const messages = await store.listMessages(session.id);
      const user = messages
        .filter((message) => message.role === "user")
        .at(-1)!;
      if (action.kind === "direct")
        expect(
          (user.metadata as { actions?: unknown } | undefined)?.actions,
        ).toEqual([expect.objectContaining({ ...action, source: "player" })]);
      const started = (
        await store.queryTraceEvents(session.id, {
          types: ["turn.started"],
          newestFirst: true,
          limit: 1,
        })
      )[0]!;
      const input = (started.payload as { playerInput: unknown })
        .playerInput as {
        actions: Record<string, unknown>[];
      };
      expect(input.actions).toEqual([
        expect.objectContaining({ ...action, source: "player" }),
      ]);
      if (action.kind === "advance") {
        expect(input.actions[0]).not.toHaveProperty("text");
        expect(
          messages.filter((message) => message.role === "user"),
        ).toHaveLength(1);
      }
      expect(
        messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.includes("A public bell rings."),
        ),
      ).toBe(true);
    }
    const count = (await store.listMessages(session.id)).length;
    const modelCalls = generate.mock.calls.length;
    for (const action of [
      { kind: "direct", seatId: "missing", text: "Forged seat" },
      {
        kind: "direct",
        seatId: "main",
        actorId: "forged",
        text: "Forged actor",
      },
      {
        kind: "direct",
        seatId: "main",
        source: "system",
        text: "Forged source",
      },
    ]) {
      const response = await post(action);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await store.listMessages(session.id)).length).toBe(count);
    }
    await store.updateSession(session.id, {
      seats: [
        { id: "main", role: "spectator", controller: "human", characters: [] },
      ],
    });
    const rejected = await post({
      kind: "direct",
      seatId: "main",
      text: "No spectator direction",
    });
    expect(rejected.status).toBe(409);
    expect((await store.listMessages(session.id)).length).toBe(count);
    expect(generate).toHaveBeenCalledTimes(modelCalls);
  } finally {
    await closeTestApi(boot);
    await rm(user, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
