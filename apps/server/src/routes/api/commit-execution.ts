import { commitExecution as commitRuntimeExecution } from "@covel/runtime";
import type { MemorySystem } from "@covel/memory";

/** Schedule only durable state; the memory system tracks work for shutdown drain. */
export function scheduleMemoryIngest(
  memory: MemorySystem | undefined,
  sessionId: string,
): void {
  if (!memory) return;
  void memory.ingest(sessionId).catch(() => {
    console.warn(`[memory] ingestion failed for ${sessionId}`);
  });
}

/** Shared host commit boundary for player, manual, resumed and background work. */
export async function commitExecution(
  args: Parameters<typeof commitRuntimeExecution>[0] & {
    readonly memorySystem?: MemorySystem;
  },
): ReturnType<typeof commitRuntimeExecution> {
  const outcome = await commitRuntimeExecution(args);
  if (outcome.status === "committed") {
    scheduleMemoryIngest(args.memorySystem, args.execution.commit.sessionId);
  }
  return outcome;
}
