import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRpcApprovalGate } from "@covel/approval";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type LoadedRuntime,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
} from "@covel/plugin-loader";
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  submitFormHandler,
  type LLMAdapter,
  type LLMResponse,
} from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import { deriveLegacyClockForSession } from "@covel/shared";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { pluginRpcRoutes } from "../../src/routes/api/plugin-rpc.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

class NoopLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: "{}",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

interface ActionEnvelope {
  readonly type: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly payload: Record<string, unknown>;
}

function fnManifest(
  name: string,
  priority: number,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    pluginType: "core-plugin",
    description: name,
    stage:
      priority <= 99
        ? "setup"
        : priority <= 499
          ? "pre-turn"
          : priority === 500
            ? "narrative"
            : priority <= 999
              ? "post-turn"
              : "audit",
    runtimeType: "function",
    outputKind: "plugin",
    handler: "./handler.js",
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

function makeSummary(id: string): PluginSummary {
  return {
    id,
    name: id,
    description: id,
    pluginType: "core-plugin",
    runtimeCount: 1,
  };
}

function makeEntry(id: string, loaded: LoadedRuntime): PluginRegistryEntry {
  const parsed = {
    manifest: loaded.manifest,
    promptTemplate: loaded.promptTemplate,
    rawFrontmatter: {},
  };
  return {
    id,
    summary: makeSummary(id),
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[loaded.manifest.name, loaded]]),
    status: "registered",
  } as PluginRegistryEntry;
}

async function drainActionStream(res: Response): Promise<ActionEnvelope[]> {
  const envelopes: ActionEnvelope[] = [];
  if (!res.body) return envelopes;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        envelopes.push(JSON.parse(line.slice(6)) as ActionEnvelope);
      }
    }
  }

  return envelopes;
}

function makeLoadedRuntimes(store: DataStore): Map<string, LoadedRuntime> {
  const manifests = [
    fnManifest("pregame", 10),
    fnManifest("world-init/schema-gen", 85),
    fnManifest("char-creator/player-init", 90, {
      needs: ["pregame", "world-init/schema-gen"],
    }),
    fnManifest("narrator", 500, { outputKind: "story" }),
  ];
  const loaded = new Map<string, LoadedRuntime>();

  for (const manifest of manifests) {
    loaded.set(manifest.name, {
      manifest,
      promptTemplate: "",
      handler: async () => {
        if (manifest.name === "pregame") {
          return { narrativeOutput: "pregame ready", preGameDone: true };
        }
        if (manifest.name === "world-init/schema-gen") {
          return { narrativeOutput: "world ready", preGameDone: true };
        }
        if (manifest.name === "char-creator/player-init") {
          const inputs = await store.listPlayerInputs("sess-start-flow-api");
          const latest = inputs.at(-1);
          const values =
            latest?.values && typeof latest.values === "object"
              ? (latest.values as Record<string, unknown>)
              : undefined;

          if (!values) {
            return {
              narrativeOutput: "character form ready",
              interactions: [
                {
                  type: "form",
                  interactionId: "form-char-creation",
                  narrativeTemplate: "Player {{name}} enters as {{concept}}.",
                  fields: [
                    { id: "name", label: "Name", type: "text" },
                    { id: "concept", label: "Concept", type: "text" },
                  ],
                },
              ],
            };
          }

          const now = new Date().toISOString();
          const character = {
            id: "player-1",
            sessionId: "sess-start-flow-api",
            name: String(values.name),
            type: "player",
            description: String(values.concept ?? ""),
            fields: values,
          };
          await store.upsertCharacter({
            ...character,
            version: 1,
            createdAt: now,
            updatedAt: now,
          });
          await store.setPluginData({
            id: "player-1",
            sessionId: "sess-start-flow-api",
            pluginId: "char-creator",
            namespace: "characters",
            key: "player-1",
            value: character,
            createdAt: now,
            updatedAt: now,
          });
          return { narrativeOutput: "player ready", preGameDone: true };
        }

        return { narrativeOutput: "main loop started" };
      },
    });
  }

  return loaded;
}

function makeApp(
  store: DataStore,
  registry: PluginRegistry,
  loaded: Map<string, LoadedRuntime>,
): Hono {
  const app = new Hono();
  const eventBus = createEventBus(store);
  const sessionLock = createInProcessSessionLock();
  const rpcRegistry = createPluginRpcRegistry();
  rpcRegistry.registerFrameworkDefault("submit-form", submitFormHandler);
  const rpcExecutor = createRpcExecutor({
    registry: rpcRegistry,
    loadHandler: async () => {
      throw new Error("plugin handler lookup skipped in scenario tests");
    },
  });
  const rpcApprovalGate = createRpcApprovalGate();

  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("llmAdapter", new NoopLLM());
    c.set("loadRuntimeFn", async (manifest: RuntimeManifest) =>
      loaded.get(manifest.name),
    );
    c.set("toolExecutor", undefined);
    c.set("resolveModel", () => undefined);
    c.set("eventBus", eventBus);
    c.set("sessionLock", sessionLock);
    c.set("rpcExecutor", rpcExecutor);
    c.set("rpcRegistry", rpcRegistry);
    c.set("rpcApprovalGate", rpcApprovalGate);
    await next();
  });
  app.route("/api/actions", actionRoutes);
  app.route("/api/sessions", pluginRpcRoutes);
  return app;
}

describe("start-game API lifecycle scenario", () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;
  let loaded: Map<string, LoadedRuntime>;

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    loaded = makeLoadedRuntimes(store);

    for (const runtime of loaded.values()) {
      registry.register(makeEntry(runtime.manifest.pluginId, runtime));
    }

    await store.createSession({
      id: "sess-start-flow-api",
      worldId: "world-1",
      presetId: null,
      status: "active",
      activePlugins: ["pregame", "world-init", "char-creator", "narrator"],
      turnCount: 0,
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    app = makeApp(store, registry, loaded);
  });

  it("start_session leaves setup active while the character form is pending", async () => {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-start",
        type: "start_session",
        sessionId: "sess-start-flow-api",
        payload: {},
      }),
    });
    expect(res.status).toBe(200);

    const events = await drainActionStream(res);
    expect(events.map((event) => event.type)).toContain(
      "interaction.requested",
    );

    const session = await store.getSession("sess-start-flow-api");
    expect(deriveLegacyClockForSession(session!).turnCount).toBe(0);

    const playerMessages = (await store.listTurnMessages("sess-start-flow-api"))
      .filter((message) => message.sourceType === "player")
      .map((message) => message.content);
    expect(playerMessages).toEqual([]);
  });

  it("submit follow-up creates the player on the setup turn; the same request chains the opening narrative turn", async () => {
    const start = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-start",
        type: "start_session",
        sessionId: "sess-start-flow-api",
        payload: {},
      }),
    });
    const startEvents = await drainActionStream(start);
    const bootstrapTurnId = startEvents[0]?.turnId ?? "turn-bootstrap";

    const submit = await app.request(
      "/api/sessions/sess-start-flow-api/plugin-rpc",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId: "framework",
          action: "submit-form",
          payload: {
            turnId: bootstrapTurnId,
            submissions: [
              {
                interactionId: "form-char-creation",
                type: "form",
                values: { name: "Aria", concept: "cartographer" },
              },
            ],
          },
        }),
      },
    );
    expect(submit.status).toBe(200);
    const submitted = (await submit.json()) as {
      result: { results: ReadonlyArray<{ filledNarrative: string }> };
    };
    const filledNarrative = submitted.result.results[0]!.filledNarrative;

    const followup = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-followup",
        type: "send_message",
        sessionId: "sess-start-flow-api",
        payload: { content: filledNarrative },
      }),
    });
    expect(followup.status).toBe(200);
    const followupEvents = await drainActionStream(followup);
    const followupTurnId = followupEvents[0]?.turnId ?? "turn-form-submit";

    const characters = await store.listCharacters("sess-start-flow-api");
    expect(characters).toHaveLength(1);
    expect(characters[0]?.name).toBe("Aria");

    const mirrored = await store.getPluginData(
      "sess-start-flow-api",
      "char-creator",
      "characters",
      "player-1",
    );
    expect(mirrored?.value).toMatchObject({ name: "Aria", type: "player" });

    // The form-submit turn itself runs ONLY the setup runtime that creates the
    // player (Step 2 transaction discipline: its execution commits on its own).
    const runtimeRows = await store.listRuntimeResults(
      "sess-start-flow-api",
      followupTurnId,
    );
    const runtimeIds = runtimeRows.map((row) => row.runtimeId);
    expect(runtimeIds).toEqual(
      expect.arrayContaining(["char-creator/player-init"]),
    );
    expect(
      runtimeIds.filter((runtimeId) => runtimeId === "narrator"),
    ).toHaveLength(0);

    // Opening continuation: the SAME request then chains one main-loop turn
    // (a second transaction reading the just-committed setup state), so the
    // narrator produces the opening narrative without the player having to
    // send another message. The chained turn rides the same SSE stream under
    // a fresh turnId.
    const turnIds = [
      ...new Set(followupEvents.map((event) => event.turnId)),
    ].filter(Boolean);
    expect(turnIds).toHaveLength(2);
    const openingTurnId = turnIds.find((id) => id !== followupTurnId)!;
    const openingRuntimeIds = (
      await store.listRuntimeResults("sess-start-flow-api", openingTurnId)
    ).map((row) => row.runtimeId);
    expect(
      openingRuntimeIds.filter((runtimeId) => runtimeId === "narrator"),
    ).toHaveLength(1);

    // Exactly one execution.completed closes the stream (the continuation is
    // part of the same execution from the client's point of view).
    expect(
      followupEvents.filter((event) => event.type === "execution.completed"),
    ).toHaveLength(1);

    // The chained opening turn is the first counted player turn.
    const session = await store.getSession("sess-start-flow-api");
    expect(deriveLegacyClockForSession(session!).turnCount).toBe(1);
    expect(session?.completedPlayerTurns).toBe(1);

    const turnResults = await store.listTurnResults("sess-start-flow-api");
    expect(turnResults).toHaveLength(3);

    const firstMainLoop = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-main-1",
        type: "send_message",
        sessionId: "sess-start-flow-api",
        payload: { content: "look around" },
      }),
    });
    expect(firstMainLoop.status).toBe(200);
    const firstMainLoopEvents = await drainActionStream(firstMainLoop);
    const firstMainLoopTurnId =
      firstMainLoopEvents[0]?.turnId ?? "turn-first-main";

    // A regular playing-band request runs the narrator once and does NOT chain
    // a continuation turn.
    const mainLoopRuntimeIds = (
      await store.listRuntimeResults("sess-start-flow-api", firstMainLoopTurnId)
    ).map((row) => row.runtimeId);
    expect(
      mainLoopRuntimeIds.filter((runtimeId) => runtimeId === "narrator"),
    ).toHaveLength(1);
    expect(
      new Set(firstMainLoopEvents.map((event) => event.turnId).filter(Boolean))
        .size,
    ).toBe(1);

    const afterFirstMainLoop = await store.getSession("sess-start-flow-api");
    expect(deriveLegacyClockForSession(afterFirstMainLoop!).turnCount).toBe(2);
    expect(afterFirstMainLoop?.completedPlayerTurns).toBe(2);
  });
});
