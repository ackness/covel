import { describe, expect, it } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor.js";
import type {
  LLMAdapter,
  LLMRequest,
  LLMResponse,
} from "../src/llm-adapter.js";
import playerInitGuard from "../../../plugins/char-creator/runtimes/player-init/guard.js";

class CapturingLLM implements LLMAdapter {
  readonly systemPrompts: string[] = [];

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const system = req.messages.find((message) => message.role === "system");
    if (typeof system?.content === "string") {
      this.systemPrompts.push(system.content);
    }
    return {
      content: '{"narrativeOutput":"角色信息已进入叙事上下文。"}',
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 8 },
    };
  }
}

function manifest(
  name: string,
  overrides: Partial<RuntimeManifest>,
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    priority: 500,
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

async function createPregameStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  await store.upsertWorld({
    id: "world-char-bridge",
    name: "Cloudmere",
    description: "Test world",
    lore: "云梦泽世界观",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.createSession({
    id: sessionId,
    worldId: "world-char-bridge",
    status: "active",
    turnCount: 0,
    preGameCompleted: ["pregame", "world-init/schema-gen"],
    locale: "zh-CN",
    activePlugins: ["char-creator", "narrator"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.savePlayerInput({
    id: "input-char-bridge",
    sessionId,
    turnId: "turn-form",
    formId: "char-creation",
    values: {
      characterName: "柳无痕",
      background: "外门弟子，擅长追踪灵脉异动",
      concept: "灵脉巡查者",
      sect: "青萍宗",
    },
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  return store;
}

describe("char-creator core plugin guard bridge", () => {
  it("creates the submitted player, mirrors plugin data, advances Pre-Game, and refreshes same-turn narrator context", async () => {
    const sessionId = "sess-char-bridge";
    const store = await createPregameStore(sessionId);
    const playerInit = manifest("char-creator/player-init", {
      pluginId: "char-creator",
      priority: 50,
      runtimeType: "agent",
      guard: "./guard.js",
      upstreamRequired: ["pregame", "world-init/schema-gen"],
    });
    const narrator = manifest("narrator", {
      pluginId: "narrator",
      priority: 500,
      runtimeType: "agent",
      outputKind: "story",
    });
    const llm = new CapturingLLM();
    const input: TurnInput = {
      sessionId,
      turnId: "turn-form",
      playerMessage: "柳无痕完成登记。",
      locale: "zh-CN",
    };
    const deps: TurnExecutorDeps = {
      loadRuntime: async (runtime) => {
        if (runtime.name === "char-creator/player-init") {
          return {
            manifest: runtime,
            promptTemplate: "",
            references: [],
            guard: playerInitGuard,
          };
        }
        return {
          manifest: runtime,
          promptTemplate:
            "Player={{ player.character.name }}; Description={{ player.character.description }}; Character={{ player.character }}.",
          references: [],
        };
      },
      llm,
      getConfig: () => ({}),
      getPluginSource: (pluginId) =>
        pluginId === "char-creator" || pluginId === "narrator"
          ? "builtin"
          : "community",
      store,
    };

    const result = await executeTurn(input, [playerInit, narrator], deps);

    expect(result.runtimeResults.map((runtime) => runtime.runtimeId)).toEqual([
      "char-creator/player-init",
      "narrator",
    ]);
    expect(result.runtimeResults[0]!.status).toBe("skipped");
    expect(result.runtimeResults[0]!.output).toMatchObject({
      skip: true,
      playerExists: true,
      playerName: "柳无痕",
      preGameDone: true,
    });

    const session = await store.getSession(sessionId);
    expect(session?.turnCount).toBe(1);
    expect(session?.preGameCompleted?.slice().sort()).toEqual(
      ["char-creator/player-init", "pregame", "world-init/schema-gen"].sort(),
    );

    const characters = await store.listCharacters(sessionId);
    expect(characters).toHaveLength(1);
    expect(characters[0]).toMatchObject({
      name: "柳无痕",
      type: "player",
      description: "外门弟子，擅长追踪灵脉异动",
      fields: {
        concept: "灵脉巡查者",
        sect: "青萍宗",
      },
    });

    const mirrors = await store.listPluginData(
      sessionId,
      "char-creator",
      "characters",
    );
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0].value).toMatchObject({
      name: "柳无痕",
      type: "player",
      description: "外门弟子，擅长追踪灵脉异动",
    });

    expect(llm.systemPrompts).toHaveLength(1);
    expect(llm.systemPrompts[0]).toContain("Player=柳无痕");
    expect(llm.systemPrompts[0]).toContain(
      "Description=外门弟子，擅长追踪灵脉异动",
    );
  });
});
