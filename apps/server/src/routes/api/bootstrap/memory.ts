import { getPluginTrustInfo } from "@covel/plugin-loader";
import type { ParsedPluginMd, PluginSource } from "@covel/plugin-loader";
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
  /**
   * Resolve a plugin's discovery-source trust tier (load-path derived, so
   * non-forgeable). Used to break `memoryBlocks` label collisions by trust
   * (builtin > official > community) rather than discovery order, so a
   * community plugin can never silently shadow a builtin default block.
   * Optional: when omitted every plugin resolves to the community fallback
   * and collisions degrade to first-declaration-wins (fine for tests and
   * standalone boots with no third-party plugins).
   */
  readonly getPluginSource?: (pluginId: string) => PluginSource | undefined;
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
  getPluginSource,
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
  const memoryBlocks = collectMemoryBlockSchemas(
    manifestCache,
    getPluginSource,
  );
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
 * Trust ranking used to break `memoryBlocks` label collisions. Higher wins.
 * Derived from the non-forgeable discovery `source` (the load path a plugin
 * was found in), never from a concrete plugin id — this keeps the resolution
 * within the framework↔plugin isolation rule: no `if (pluginId === 'memory')`
 * style control flow, only trust-tier comparison on discovery source.
 */
const TRUST_RANK: Readonly<Record<PluginSource, number>> = {
  builtin: 3,
  official: 2,
  community: 1,
};

/**
 * Aggregate `memoryBlocks` declared across all loaded plugin manifests.
 *
 * Block definitions are plain plugin/world data — the framework discovers them
 * here and feeds them to the memory system, never hardcoding a block
 * vocabulary. The builtin `memory` plugin supplies the default narrative
 * blocks; any plugin or world can contribute additional ones (e.g. a detective
 * pack adding `clues` / `suspects` / `timeline`). Manifests are validated at
 * load time, so each entry already matches `MemoryBlockSchema`.
 *
 * Duplicate labels resolve by **trust tier** (builtin > official > community):
 * a higher-trust declaration always overrides a lower-trust one regardless of
 * discovery order, so a community plugin can never silently shadow a builtin
 * default block (e.g. redefining `story_state`'s extractionHint) just by
 * loading first. Within the same tier the first declaration wins (stable), and
 * a same-tier conflict with diverging definitions emits a dev warning.
 */
function collectMemoryBlockSchemas(
  manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>,
  getPluginSource?: (pluginId: string) => PluginSource | undefined,
): readonly MemoryBlockSchema[] {
  const byLabel = new Map<
    string,
    {
      readonly block: MemoryBlockSchema;
      readonly rank: number;
      readonly pluginId: string;
    }
  >();
  for (const [pluginId, manifests] of manifestCache) {
    // Trust comes from the discovery source (load path). Absent source falls
    // through to the community tier via `getPluginTrustInfo` — never inferred
    // from the plugin id.
    const trust = getPluginTrustInfo(pluginId, getPluginSource?.(pluginId));
    const rank = TRUST_RANK[trust.source];
    for (const m of manifests) {
      const blocks = m.manifest.memoryBlocks;
      if (!blocks) continue;
      for (const block of blocks) {
        const existing = byLabel.get(block.label);
        if (!existing) {
          byLabel.set(block.label, { block, rank, pluginId });
          continue;
        }
        if (rank > existing.rank) {
          // Higher-trust plugin overrides a lower-trust declaration.
          byLabel.set(block.label, { block, rank, pluginId });
          continue;
        }
        if (
          rank === existing.rank &&
          existing.pluginId !== pluginId &&
          !memoryBlocksEqual(existing.block, block)
        ) {
          // Same trust tier, different plugins, diverging definitions: keep
          // the first (stable) but surface the clash so authors can fix it.
          console.warn(
            `[bootstrap] memoryBlocks label "${block.label}" declared by both "${existing.pluginId}" and "${pluginId}" at the same trust tier (${trust.source}) with differing definitions — keeping "${existing.pluginId}"`,
          );
        }
      }
    }
  }
  return [...byLabel.values()].map((e) => e.block);
}

/** Field-by-field equality for two memory block schemas (order-independent). */
function memoryBlocksEqual(
  a: MemoryBlockSchema,
  b: MemoryBlockSchema,
): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Deterministic JSON encoding with sorted object keys for stable comparison. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}
