import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
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
import { actionRoutes } from "../../src/routes/api/actions.js";
import { submitInputsRoutes } from "../../src/routes/api/submit-inputs.js";
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
    priority,
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
    referenceLinks: [],
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
      upstreamRequired: ["pregame", "world-init/schema-gen"],
    }),
    fnManifest("narrator", 500, { outputKind: "story" }),
  ];
  const loaded = new Map<string, LoadedRuntime>();

  for (const manifest of manifests) {
    loaded.set(manifest.name, {
      manifest,
      promptTemplate: "",
      references: [],
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
                  fields: [{ id: "name", label: "Name", type: "text" }],
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

  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("llmAdapter", new NoopLLM());
    c.set("loadRuntimeFn", async (manifest: RuntimeManifest) =>
      loaded.get(manifest.name),
    );
    c.set("toolExecutor", undefined);
    c.set("getConfigFn", () => ({}));
    c.set("resolveModel", () => undefined);
    c.set("eventBus", eventBus);
    c.set("sessionLock", sessionLock);
    c.set("rpcExecutor", rpcExecutor);
    await next();
  });
  app.route("/api/actions", actionRoutes);
  app.route("/api/sessions", submitInputsRoutes);
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
    expect(session?.turnCount).toBe(0);

    const playerMessages = (await store.listTurnMessages("sess-start-flow-api"))
      .filter((message) => message.sourceType === "player")
      .map((message) => message.content);
    expect(playerMessages).toEqual([]);
  });

  it("submit follow-up creates the player before narrator runs", async () => {
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
      "/api/sessions/sess-start-flow-api/submit-inputs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turnId: bootstrapTurnId,
          formId: "form-char-creation",
          values: { name: "Aria", concept: "cartographer" },
        }),
      },
    );
    expect(submit.status).toBe(200);
    const submitted = (await submit.json()) as { filledNarrative: string };

    const followup = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-followup",
        type: "send_message",
        sessionId: "sess-start-flow-api",
        payload: { content: submitted.filledNarrative },
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
    ).toHaveLength(1);

    const session = await store.getSession("sess-start-flow-api");
    expect(session?.turnCount).toBe(1);
  });
});
