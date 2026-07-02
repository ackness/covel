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
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates memory tools and uses the preferred memory slot for LLM calls", async () => {
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

  it("breaks memoryBlocks label collisions by trust tier — builtin overrides community regardless of discovery order", async () => {
    const store = createMemoryStore();
    // A community plugin is inserted FIRST and redefines the builtin
    // `story_state` block with a divergent icon/displayName. Discovery order
    // must NOT let it shadow the builtin definition.
    const manifestCache = new Map<string, readonly ParsedPluginMd[]>([
      [
        "evil-pack",
        [
          parsedManifest({
            name: "evil-pack",
            pluginId: "evil-pack",
            memoryBlocks: [
              {
                label: "story_state",
                displayName: { zh: "劫持", en: "Hijacked" },
                icon: "Skull",
                extractionHint: { zh: "恶意覆盖", en: "Malicious override" },
              },
            ],
          }),
        ],
      ],
      [
        "memory",
        [
          parsedManifest({
            name: "memory",
            pluginId: "memory",
            memoryBlocks: [
              {
                label: "story_state",
                displayName: { zh: "剧情状态", en: "Story State" },
                icon: "BookOpen",
                extractionHint: { zh: "主线剧情摘要。", en: "Main plot." },
              },
            ],
          }),
        ],
      ],
    ]);

    const result = createBootstrapMemorySystem({
      manifestCache,
      store,
      llmAdapter: new RecordingLlm(),
      resolveModel: (manifest) => manifest.model,
      // Trust derived from the (test-simulated) discovery source, not the id.
      getPluginSource: (id) => (id === "memory" ? "builtin" : "community"),
    });

    expect(result).toBeDefined();
    await result!.memorySystem.manager.initializeDefaults("s1");
    const blocks = await result!.memorySystem.manager.loadBlocks("s1");
    const storyState = blocks.find((b) => b.label === "story_state");

    // The builtin definition wins on icon + displayName even though the
    // community plugin was discovered first.
    expect(storyState?.icon).toBe("BookOpen");
    expect(storyState?.displayName).toEqual({
      zh: "剧情状态",
      en: "Story State",
    });
  });

  it("warns when two same-tier plugins declare the same label with differing definitions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manifestCache = new Map<string, readonly ParsedPluginMd[]>([
      [
        "pack-a",
        [
          parsedManifest({
            name: "pack-a",
            pluginId: "pack-a",
            memoryBlocks: [
              {
                label: "clues",
                displayName: { en: "Clues A" },
                icon: "Search",
                extractionHint: { en: "variant a" },
              },
            ],
          }),
        ],
      ],
      [
        "pack-b",
        [
          parsedManifest({
            name: "pack-b",
            pluginId: "pack-b",
            memoryBlocks: [
              {
                label: "clues",
                displayName: { en: "Clues B" },
                icon: "Search",
                extractionHint: { en: "variant b" },
              },
            ],
          }),
        ],
      ],
    ]);

    createBootstrapMemorySystem({
      manifestCache,
      store: createMemoryStore(),
      llmAdapter: new RecordingLlm(),
      resolveModel: (manifest) => manifest.model,
      getPluginSource: () => "community",
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('memoryBlocks label "clues"'),
    );
  });

  it("fires embed-on-write ingestion from the post-turn updater when embed is injected", async () => {
    const DIM = 8;
    const store = createMemoryStore();
    const sessionId = "session-ingest";

    // Lock an embedding model so the session has a vector target.
    const target = await store.ensureVectorModel!({
      provider: "test",
      modelName: "fake",
      dim: DIM,
      modelId: "test/fake",
    });
    await store.lockSessionEmbeddingModel!(sessionId, target);

    // Seed a turn message for ingestion to pick up.
    await store.appendTurnMessage({
      id: "msg-1",
      sessionId,
      turnId: "turn-1",
      sourceType: "runtime",
      role: "assistant",
      content: "the king summoned the council",
      order: 1,
      createdAt: new Date().toISOString(),
    });

    const embedCalls: string[][] = [];
    const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
      embedCalls.push([...texts]);
      return texts.map(() => new Float32Array(DIM).fill(0.1));
    };

    const result = createBootstrapMemorySystem({
      manifestCache: new Map(),
      store,
      llmAdapter: new RecordingLlm(),
      embed,
      preferredMemorySlot: "memory",
      resolveModel: (manifest) => manifest.model,
    });
    expect(result).toBeDefined();

    // The turn executor fires this post-turn; the bootstrap wrapper must also
    // kick a best-effort ingest sweep (fire-and-forget).
    await result!.memorySystem.updater.updateAfterTurn({
      sessionId,
      narrativeText: "the king summoned the council",
      currentBlocks: [],
    });

    // Ingestion is fired without await — give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(embedCalls.length).toBeGreaterThan(0);
    // The seeded message must now be searchable as a recall vector.
    const hits = await store.searchVectors!({
      sessionId,
      query: new Float32Array(DIM).fill(0.1),
      topK: 5,
      pluginId: "__memory__",
      namespace: "recall",
    });
    expect(hits.map((h) => h.key)).toContain("msg-1");
  });
});
