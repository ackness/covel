import { describe, expect, it } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

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

const manifests = [
  fnManifest("pregame", 10),
  fnManifest("world-init/schema-gen", 85),
  fnManifest("char-creator/player-init", 90, {
    upstreamRequired: ["pregame", "world-init/schema-gen"],
  }),
  fnManifest("narrator", 500, { outputKind: "story" }),
] as const;

async function createScenarioStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    worldId: "world-1",
    presetId: null,
    status: "active",
    activePlugins: ["pregame", "world-init", "char-creator", "narrator"],
    turnCount: 0,
    preGameCompleted: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return store;
}

function makeRuntimeHarness(store: DataStore): {
  deps: TurnExecutorDeps;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  const loaded = new Map<string, LoadedRuntime>();

  for (const manifest of manifests) {
    loaded.set(manifest.name, {
      manifest,
      promptTemplate: "",
      references: [],
      handler: async () => {
        calls[manifest.name] = (calls[manifest.name] ?? 0) + 1;

        if (manifest.name === "pregame") {
          return { narrativeOutput: "pregame ready", preGameDone: true };
        }
        if (manifest.name === "world-init/schema-gen") {
          return { narrativeOutput: "world ready", preGameDone: true };
        }
        if (manifest.name === "char-creator/player-init") {
          const inputs = await store.listPlayerInputs("sess-start-flow");
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
            sessionId: "sess-start-flow",
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
            sessionId: "sess-start-flow",
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

  return {
    calls,
    deps: {
      loadRuntime: async (manifest) => loaded.get(manifest.name),
      llm: new NoopLLM(),
      getConfig: () => ({}),
      store,
    },
  };
}

async function runTurn(
  store: DataStore,
  deps: TurnExecutorDeps,
  input: Partial<TurnInput>,
) {
  return executeTurn(
    {
      sessionId: "sess-start-flow",
      turnId: crypto.randomUUID(),
      playerMessage: "",
      ...input,
    },
    manifests,
    deps,
  );
}

describe("start-game flow scenario at runtime level", () => {
  it("start_session bootstrap keeps player history clean while the character form is pending", async () => {
    const store = await createScenarioStore("sess-start-flow");
    const { deps } = makeRuntimeHarness(store);

    const result = await runTurn(store, deps, {
      turnId: "turn-bootstrap",
      playerMessage: "",
    });

    expect(
      result.pendingInputs?.map((pending) => pending.interaction.interactionId),
    ).toEqual(["form-char-creation"]);
    const playerMessages = (await store.listTurnMessages("sess-start-flow"))
      .filter((message) => message.sourceType === "player")
      .map((message) => message.content);
    expect(playerMessages).toEqual([]);

    const session = await store.getSession("sess-start-flow");
    expect(session?.turnCount).toBe(0);
    expect(session?.preGameCompleted?.sort()).toEqual(
      ["pregame", "world-init/schema-gen"].sort(),
    );
  });

  it("form submission creates the player before main-loop runtimes run", async () => {
    const store = await createScenarioStore("sess-start-flow");
    const { deps, calls } = makeRuntimeHarness(store);

    await runTurn(store, deps, { turnId: "turn-bootstrap", playerMessage: "" });
    await store.savePlayerInput({
      id: "input-1",
      sessionId: "sess-start-flow",
      turnId: "turn-bootstrap",
      formId: "form-char-creation",
      values: { name: "Aria", concept: "cartographer" },
      createdAt: new Date().toISOString(),
    });

    await runTurn(store, deps, {
      turnId: "turn-form-submit",
      playerMessage: "Player Aria enters as cartographer.",
    });

    const characters = await store.listCharacters("sess-start-flow");
    expect(characters).toHaveLength(1);
    expect(characters[0]?.name).toBe("Aria");

    const mirrored = await store.getPluginData(
      "sess-start-flow",
      "char-creator",
      "characters",
      "player-1",
    );
    expect(mirrored?.value).toMatchObject({ name: "Aria", type: "player" });

    expect(calls["char-creator/player-init"]).toBeGreaterThanOrEqual(2);
    expect(calls["narrator"]).toBe(1);
    expect(
      (
        await store.listRuntimeResults("sess-start-flow", "turn-form-submit")
      ).map((result) => result.runtimeId),
    ).toEqual(["char-creator/player-init", "narrator"]);

    const session = await store.getSession("sess-start-flow");
    expect(session?.turnCount).toBe(1);
    expect(session?.preGameCompleted?.sort()).toEqual(
      ["char-creator/player-init", "pregame", "world-init/schema-gen"].sort(),
    );
  });
});
