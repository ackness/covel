import type { ParsedPluginMd } from "@covel/plugin-loader";
import { createMemorySystem, type MemorySystem } from "@covel/memory";
import type { LLMAdapter } from "@covel/runtime";
import { FrameworkCapability } from "@covel/shared";
import type { MemoryBlockSchema, RuntimeManifest } from "@covel/shared";
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
      `[bootstrap] No plugin declares capability "${FrameworkCapability.MemoryPanel}" — mirror disabled`,
    );
  }

  // Core-memory block schema is plugin/world data, not kernel-hardcoded: collect
  // every plugin's declared `memoryBlocks` and let the memory system drive
  // extraction/rendering off it. When none are declared the memory package
  // falls back to its generic DEFAULT_CORE_MEMORY_BLOCKS.
  const memoryBlocks = collectMemoryBlockSchemas(manifestCache);
  if (memoryBlocks.length > 0) {
    console.log(
      `[bootstrap] Core memory blocks (${memoryBlocks.length}): ${memoryBlocks
        .map((b) => b.label)
        .join(", ")}`,
    );
  } else {
    console.log(
      "[bootstrap] No plugin declares memoryBlocks — using framework default blocks",
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
      coreMemory: {
        ...(memoryPanelPluginId ? { pluginId: memoryPanelPluginId } : {}),
        ...(memoryBlocks.length > 0 ? { blocks: memoryBlocks } : {}),
      },
      updater: { modelSlot: resolvedMemorySlot },
    },
  );

  console.log(
    "[bootstrap] Memory system initialized — core memory blocks + recall/archival search",
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
      manifests.some((m) =>
        m.manifest.capabilities?.includes(FrameworkCapability.MemoryPanel),
      )
    ) {
      return pluginId;
    }
  }
  return undefined;
}

/**
 * Aggregate `memoryBlocks` declared across all loaded plugin manifests.
 *
 * Block definitions are plain plugin/world data — the framework discovers them
 * here and feeds them to the memory system, never hardcoding a block
 * vocabulary. The builtin `memory` plugin supplies the default narrative
 * blocks; any plugin or world can contribute additional ones (e.g. a detective
 * pack adding `clues` / `suspects` / `timeline`). Manifests are validated at
 * load time, so each entry already matches `MemoryBlockSchema`. Duplicate
 * labels resolve first-declaration-wins to keep defaults stable.
 */
function collectMemoryBlockSchemas(
  manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>,
): readonly MemoryBlockSchema[] {
  const byLabel = new Map<string, MemoryBlockSchema>();
  for (const [, manifests] of manifestCache) {
    for (const m of manifests) {
      const blocks = m.manifest.memoryBlocks;
      if (!blocks) continue;
      for (const block of blocks) {
        if (!byLabel.has(block.label)) {
          byLabel.set(block.label, block);
        }
      }
    }
  }
  return [...byLabel.values()];
}
