import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedPluginMd } from "@covel/plugin-loader";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import { createBootstrapMemorySystem } from "../../src/routes/api/bootstrap/memory.js";

function parsedManifest(
  manifest: Partial<RuntimeManifest> & Pick<RuntimeManifest, "name">,
): ParsedPluginMd {
  return {
    manifest: {
      pluginId: manifest.name.split("/")[0] ?? manifest.name,
      description: "test runtime",
      ...manifest,
    } as RuntimeManifest,
    promptTemplate: "",
    referenceLinks: [],
    rawFrontmatter: {},
  };
}

class RecordingLlm implements LLMAdapter {
  models: Array<string | undefined> = [];

  async generate(params: {
    readonly model?: string;
    readonly messages: readonly { role: string; content: string }[];
  }): Promise<LLMResponse> {
    this.models.push(params.model);
    return {
      content: "{}",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

describe("createBootstrapMemorySystem", () => {
  const originalFlag = process.env.COVEL_MEMORY_V1;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.COVEL_MEMORY_V1;
    } else {
      process.env.COVEL_MEMORY_V1 = originalFlag;
    }
    vi.restoreAllMocks();
  });

  it("returns undefined and registers no tools when memory is disabled", () => {
    delete process.env.COVEL_MEMORY_V1;

    const result = createBootstrapMemorySystem({
      manifestCache: new Map(),
      store: createMemoryStore(),
      llmAdapter: new RecordingLlm(),
      resolveModel: (manifest) => manifest.model,
    });

    expect(result).toBeUndefined();
  });

  it("creates memory tools and uses the preferred memory slot for LLM calls", async () => {
    process.env.COVEL_MEMORY_V1 = "1";
    const llm = new RecordingLlm();

    const result = createBootstrapMemorySystem({
      manifestCache: new Map(),
      store: createMemoryStore(),
      llmAdapter: llm,
      preferredMemorySlot: "memory",
      resolveModel: (manifest) => `resolved:${manifest.name}`,
    });

    expect(result).toBeDefined();
    expect(result!.tools.map((t) => t.name).sort()).toEqual([
      "memory-get-block",
      "memory-search",
      "memory-update-block",
    ]);

    await result!.memorySystem.updater.updateAfterTurn({
      sessionId: "session-1",
      narrativeText: "new clue",
      currentBlocks: [],
    });

    expect(llm.models).toEqual(["memory"]);
  });

  it("mirrors core memory blocks to the plugin that declares memory-panel capability", async () => {
    process.env.COVEL_MEMORY_V1 = "1";
    const store = createMemoryStore();
    const manifestCache = new Map<string, readonly ParsedPluginMd[]>([
      [
        "memory-ui",
        [
          parsedManifest({
            name: "memory-ui",
            pluginId: "memory-ui",
            capabilities: ["memory-panel"],
          }),
        ],
      ],
    ]);

    const result = createBootstrapMemorySystem({
      manifestCache,
      store,
      llmAdapter: new RecordingLlm(),
      resolveModel: (manifest) => manifest.model,
    });

    expect(result).toBeDefined();

    await result!.memorySystem.manager.updateBlock(
      "session-1",
      "story_state",
      "A door opened.",
    );

    const mirrored = await store.getPluginData(
      "session-1",
      "memory-ui",
      "blocks",
      "story_state",
    );

    expect(mirrored?.value).toMatchObject({
      content: "A door opened.",
      icon: "BookOpen",
      charCount: 14,
    });
  });
});
