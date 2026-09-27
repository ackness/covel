import {
  createMemorySystem,
  type EmbedFn,
  type MemorySystem,
} from "@covel/memory";
import type { DataStore } from "@covel/store";
import { createMemoryTools, type ToolModule } from "@covel/tools";

export interface CreateBootstrapMemorySystemParams {
  readonly store: DataStore;
  readonly embed?: EmbedFn;
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
