import {
  createMemorySystem,
  type EmbedFn,
  type MemorySystem,
  type SearchablePluginDataResolver,
} from "@covel/memory";
import type { DataStore } from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import {
  createMemoryTools,
  type ToolModule,
  type ToolRegistry,
} from "@covel/tools";
import { memoryIngestLockId } from "../../../lib/memory-ingest-lock.js";
import type { SessionLock } from "../../../lib/session-lock.js";
import type { ApiBootstrapConfig } from "./config.js";
import { createSearchablePluginDataResolver } from "./searchable-plugin-data.js";

export interface CreateBootstrapMemorySystemParams {
  readonly store: DataStore;
  readonly embed?: EmbedFn;
  readonly searchablePluginData?: SearchablePluginDataResolver;
  readonly runIngestExclusive?: <T>(
    sessionId: string,
    task: () => Promise<T>,
  ) => Promise<T>;
}
export interface BootstrapMemorySystem {
  readonly memorySystem: MemorySystem;
  readonly tools: readonly ToolModule[];
}
export function createBootstrapMemorySystem(
  params: CreateBootstrapMemorySystemParams,
): BootstrapMemorySystem {
  const memorySystem = createMemorySystem(params);
  return { memorySystem, tools: createMemoryTools(memorySystem) };
}

/**
 * Bootstrap stage 7: the three-tier memory system, with vector recall when
 * the store and an embed function allow it, and its tools registered as
 * builtins. Background ingestion runs under the dedicated ingest lock.
 */
export function wireBootstrapMemory(args: {
  readonly store: DataStore;
  readonly registry: PluginRegistry;
  readonly tools: ToolRegistry;
  readonly memoryIngestLock: SessionLock;
  readonly config: Pick<
    ApiBootstrapConfig,
    "vectorBackend" | "memoryEmbed" | "ensureEmbeddingLock"
  >;
}): BootstrapMemorySystem {
  const { store, registry, tools, memoryIngestLock, config } = args;
  const bootstrapMemory = createBootstrapMemorySystem({
    store,
    searchablePluginData: createSearchablePluginDataResolver({
      store,
      registry,
    }),
    ...(config.vectorBackend !== "none" && config.memoryEmbed
      ? { embed: config.memoryEmbed }
      : {}),
    runIngestExclusive: (sessionId, task) =>
      memoryIngestLock.withLock(memoryIngestLockId(sessionId), async () => {
        if (config.vectorBackend !== "none") {
          await config.ensureEmbeddingLock?.(sessionId);
        }
        return task();
      }),
  });
  for (const t of bootstrapMemory.tools) {
    tools.registerBuiltin(t);
  }
  return bootstrapMemory;
}
