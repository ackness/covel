import type { ParsedPluginMd } from "@covel/plugin-loader";
import { createMemorySystem, type MemorySystem } from "@covel/memory";
import type { LLMAdapter } from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import { isEnvEnabled, readEnvString } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { createMemoryTools, type ToolModule } from "@covel/tools";

export interface CreateBootstrapMemorySystemParams {
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
  readonly llmAdapter: LLMAdapter;
  readonly preferredMemorySlot?: string;
  readonly resolveModel: (
    manifest: RuntimeManifest,
    apiOverride?: string,
  ) => string | undefined;
}

export interface BootstrapMemorySystem {
  readonly memorySystem: MemorySystem;
  readonly tools: readonly ToolModule[];
}

export function createBootstrapMemorySystem({
  manifestCache,
  store,
  llmAdapter,
  preferredMemorySlot,
  resolveModel,
}: CreateBootstrapMemorySystemParams): BootstrapMemorySystem | undefined {
  console.log(
    `[bootstrap] COVEL_MEMORY_V1=${readEnvString("COVEL_MEMORY_V1", "(unset)")}`,
  );

  if (!isEnvEnabled("COVEL_MEMORY_V1")) {
    return undefined;
  }

  // Resolve which slot to use for memory LLM calls. Use slot ids here so
  // memory follows the same contract as runtime bindings and player-facing
  // settings instead of reaching into internal preset ids.
  const resolvedMemorySlot = preferredMemorySlot ?? "plugin";
  console.log(`[bootstrap] Memory system using slot: ${resolvedMemorySlot}`);

  const memoryPanelPluginId = findMemoryPanelPluginId(manifestCache);
  if (memoryPanelPluginId) {
    console.log(`[bootstrap] Memory panel host plugin: ${memoryPanelPluginId}`);
  } else {
    console.log(
      '[bootstrap] No plugin declares capability "memory-panel" — mirror disabled',
    );
  }

  const memoryLlm = {
    async complete(params: {
      systemPrompt: string;
      messages: readonly { role: string; content: string }[];
      model?: string;
    }) {
      const response = await llmAdapter.generate({
        model: resolvedMemorySlot,
        messages: [
          { role: "system", content: params.systemPrompt },
          ...params.messages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        ],
      });
      return { content: response.content ?? "" };
    },
  };

  const memorySystem = createMemorySystem(
    {
      store,
      llm: memoryLlm,
      resolveSlot: (slot: string) =>
        resolveModel({ name: slot, model: slot } as RuntimeManifest),
    },
    {
      coreMemory: memoryPanelPluginId
        ? { pluginId: memoryPanelPluginId }
        : undefined,
      updater: { modelSlot: resolvedMemorySlot },
    },
  );

  console.log(
    "[bootstrap] Memory system (V1) initialized — core memory blocks + recall/archival search",
  );

  return {
    memorySystem,
    tools: createMemoryTools({
      recall: memorySystem.recall,
      archival: memorySystem.archival,
      blocks: memorySystem.manager,
    }),
  };
}

function findMemoryPanelPluginId(
  manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>,
): string | undefined {
  // Discover the memory-panel host plugin by capability tag instead of
  // hardcoding a specific plugin ID. Framework stays plugin-agnostic:
  // any plugin declaring `capabilities: [memory-panel]` becomes the
  // mirror target. When no such plugin is installed, mirroring is skipped
  // and core memory still works (panel updates via polling).
  for (const [pluginId, manifests] of manifestCache) {
    if (
      manifests.some((m) => m.manifest.capabilities?.includes("memory-panel"))
    ) {
      return pluginId;
    }
  }
  return undefined;
}
