import { getPluginTrustInfo } from "@covel/plugin-loader";
import type { ParsedPluginMd, PluginSource } from "@covel/plugin-loader";
import {
  createMemorySystem,
  DEFAULT_CORE_MEMORY_BLOCKS,
  type EmbedFn,
  type MemorySystem,
} from "@covel/memory";
import type { LLMAdapter } from "@covel/runtime";
import { FrameworkCapability } from "@covel/shared";
import type { MemoryBlockSchema, RuntimeManifest } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { createMemoryTools, type ToolModule } from "@covel/tools";

export interface CreateBootstrapMemorySystemParams {
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
  readonly llmAdapter: LLMAdapter;
  /**
   * Optional embedding function for the semantic (vector) memory tier. When
   * provided (and the store supports vectors) recall/archival upgrade to vector
   * search and embed-on-write ingestion is wired onto the post-turn path.
   */
  readonly embed?: EmbedFn;
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
  embed,
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

  // The effective base schema (plugin blocks, or the framework defaults when no
  // plugin declares any). The per-session resolver merges a session's world
  // blocks on top of this base.
  const baseBlocks: readonly MemoryBlockSchema[] =
    memoryBlocks.length > 0 ? memoryBlocks : DEFAULT_CORE_MEMORY_BLOCKS;

  // Per-session block resolver: merge the global (plugin) blocks with the
  // session's world-declared `memoryBlocks`. Base blocks win on label collision
  // (builtin defaults stay protected); the world only ADDS new genre-specific
  // labels (e.g. a detective world's `clues` / `suspects`). Cached per session —
  // a session's world is fixed for its lifetime — so the two store reads happen
  // once per session, then resolve from memory.
  const sessionBlockCache = new Map<string, readonly MemoryBlockSchema[]>();
  const resolveBlocks = async (
    sessionId: string,
  ): Promise<readonly MemoryBlockSchema[] | undefined> => {
    const cached = sessionBlockCache.get(sessionId);
    if (cached) return cached;
    let resolved: readonly MemoryBlockSchema[] = baseBlocks;
    try {
      const session = await store.getSession(sessionId);
      const world = session?.worldId
        ? await store.getWorld(session.worldId)
        : null;
      const worldBlocks = (
        world?.metadata as Record<string, unknown> | undefined
      )?.memoryBlocks;
      if (Array.isArray(worldBlocks)) {
        const taken = new Set(baseBlocks.map((b) => b.label));
        const additions = (worldBlocks as MemoryBlockSchema[]).filter(
          (b) =>
            Boolean(b) &&
            typeof b.label === "string" &&
            b.label.length > 0 &&
            !taken.has(b.label),
        );
        if (additions.length > 0) resolved = [...baseBlocks, ...additions];
      }
    } catch (err) {
      console.warn(
        `[bootstrap] world memoryBlocks resolve failed for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    sessionBlockCache.set(sessionId, resolved);
    return resolved;
  };

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

  const baseSystem = createMemorySystem(
    {
      store,
      llm: memoryLlm,
      ...(embed ? { embed } : {}),
      resolveSlot: (slot: string) =>
        resolveModel({ name: slot, model: slot } as RuntimeManifest),
    },
    {
      coreMemory: {
        ...(memoryPanelPluginId ? { pluginId: memoryPanelPluginId } : {}),
        blocks: baseBlocks,
        resolveBlocks,
      },
      updater: { modelSlot: resolvedMemorySlot },
    },
  );

  // Wire embed-on-write ingestion onto the post-turn path WITHOUT touching the
  // commit core or the turn executor. The turn executor already fires
  // `updater.updateAfterTurn(...)` fire-and-forget after each narrative turn; we
  // wrap that injected method so it ALSO kicks a best-effort `ingest(sessionId)`
  // on the same post-commit tick. Ingestion is itself fire-and-forget and never
  // throws, so it cannot block or fail the turn. No-op when vectors are disabled.
  const memorySystem: MemorySystem = embed
    ? withPostTurnIngestion(baseSystem)
    : baseSystem;

  console.log(
    `[bootstrap] Memory system initialized — core memory blocks + ${
      embed ? "semantic (vector) + keyword" : "keyword"
    } recall/archival search`,
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

/**
 * Wrap a memory system so its `updater.updateAfterTurn` also triggers a
 * best-effort vector ingestion sweep. The wrapper preserves the exact updater
 * contract the turn executor depends on (`updateAfterTurn` + optional
 * `awaitPending`); ingestion is fired without awaiting so the post-turn memory
 * refresh is never delayed by embedding latency.
 */
function withPostTurnIngestion(system: MemorySystem): MemorySystem {
  const realUpdater = system.updater;
  const wrappedUpdater: MemorySystem["updater"] = {
    ...realUpdater,
    async updateAfterTurn(params) {
      // Fire ingestion first (does not await embeddings) then run the real
      // core-memory update. Both are post-turn best-effort.
      void system.ingest(params.sessionId).catch((err: unknown) => {
        console.warn(
          `[bootstrap] memory ingest failed for ${params.sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      return realUpdater.updateAfterTurn(params);
    },
  };
  return { ...system, updater: wrappedUpdater };
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
