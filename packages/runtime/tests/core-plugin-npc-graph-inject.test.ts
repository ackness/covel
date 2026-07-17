import { describe, expect, it } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { getPendingProposals, shortIdBatch, tool, z } from "@covel/tools";
import { createCommitPipeline } from "../src/session/session-kernel.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type {
  LLMAdapter,
  LLMRequest,
  LLMResponse,
} from "../src/llm/llm-adapter.js";
import createUpsertNpcGraph from "../../../plugins/npc-graph/tools/upsert-npc-graph.js";
import ragRetrieverHandler from "../../../plugins/npc-graph/runtimes/rag-retriever/handler.js";

class CapturingLLM implements LLMAdapter {
  readonly systemPrompts: string[] = [];

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const system = req.messages.find((message) => message.role === "system");
    if (typeof system?.content === "string") {
      this.systemPrompts.push(system.content);
    }
    return {
      content: '{"narrativeOutput":"你记起了图谱中的关系。"}',
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

async function createMainLoopStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    worldId: "world-npc-graph",
    status: "active",
    turnCount: 1,
    preGameCompleted: [
      "pregame",
      "world-init/schema-gen",
      "char-creator/player-init",
    ],
    locale: "zh-CN",
    activePlugins: ["npc-graph", "narrator"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.appendTurnMessage({
    id: "prior-player",
    sessionId,
    turnId: "prior-turn",
    sourceType: "player",
    role: "user",
    content: "prior turn",
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return store;
}

async function seedNpcGraph(
  store: DataStore,
  sessionId: string,
): Promise<void> {
  const upsert = createUpsertNpcGraph({ tool, z, shortIdBatch, store });
  const result = await upsert.execute(
    {
      nodes: [
        {
          name: "萧衍笙",
          aliases: ["萧宗主"],
          type: "individual",
          labels: ["sect-leader"],
          summary: "碧波宗宗主，长期控制云梦泽上游灵脉。",
        },
        {
          name: "陆沉渊",
          type: "individual",
          labels: ["researcher"],
          summary: "青萍宗宗主，正在寻找灵脉异常的证据。",
        },
      ],
      edges: [
        {
          sourceName: "萧衍笙",
          targetName: "陆沉渊",
          relation: "COMPETES_WITH",
          strength: -0.7,
          fact: "萧衍笙长期视陆沉渊为竞争者，并暗中阻挠青萍宗调查灵脉异常。",
        },
      ],
    },
    {
      sessionId,
      turnId: "turn-seed",
      pluginId: "npc-graph",
      runtimeId: "npc-graph/extractor",
    },
  );

  await createCommitPipeline(store).commitAll(getPendingProposals(result));
}

describe("npc-graph core plugin write-read-inject path", () => {
  it("commits extractor graph writes, retrieves matching facts, and injects them into narrator prompt", async () => {
    const sessionId = "sess-npc-inject";
    const store = await createMainLoopStore(sessionId);
    await seedNpcGraph(store, sessionId);

    const retriever = manifest("npc-graph/rag-retriever", {
      pluginId: "npc-graph",
      priority: 400,
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "scheduled", interval: 1 },
    });
    const narrator = manifest("narrator", {
      pluginId: "narrator",
      priority: 500,
      runtimeType: "agent",
      outputKind: "story",
      input: {
        inject: [
          {
            kind: "runtime",
            from: "npc-graph/rag-retriever",
            field: "npcContext",
            as: "npc-relationships",
          },
        ],
      },
    });
    const llm = new CapturingLLM();
    const input: TurnInput = {
      sessionId,
      turnId: "turn-npc-inject",
      playerMessage: "我去找萧宗主谈灵脉异常。",
      locale: "zh-CN",
    };
    const deps: TurnExecutorDeps = {
      loadRuntime: async (runtime) => {
        if (runtime.name === "npc-graph/rag-retriever") {
          return {
            manifest: runtime,
            promptTemplate: "",
            handler: ragRetrieverHandler,
          };
        }
        return {
          manifest: runtime,
          promptTemplate: "Narrator prompt.",
        };
      },
      llm,
      store,
    };

    const result = await executeTurn(input, [narrator, retriever], deps);

    expect(result.runtimeResults.map((runtime) => runtime.runtimeId)).toEqual([
      "npc-graph/rag-retriever",
      "narrator",
    ]);
    const retrieverOutput = result.runtimeResults[0]!.output as Record<
      string,
      unknown
    >;
    expect(retrieverOutput.npcContext).toContain("萧衍笙");
    expect(retrieverOutput.npcContext).toContain("陆沉渊");
    expect(retrieverOutput.npcContext).toContain("COMPETES_WITH");

    expect(llm.systemPrompts).toHaveLength(1);
    expect(llm.systemPrompts[0]).toContain("<npc-relationships>");
    expect(llm.systemPrompts[0]).toContain("暗中阻挠青萍宗调查灵脉异常");
  });
});
