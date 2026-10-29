import { commitExecution as commitRuntimeExecution } from "@covel/runtime";
import { pluginFaultHost } from "./plugin-faults.js";
import { isSetupRuntime } from "@covel/shared";
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
  const faults = pluginFaultHost(args.store);
  if (faults) {
    const plan = args.execution.commit;
    const transitions = faults.latch.recordExecution({
      sessionId: plan.sessionId,
      logicalKey: plan.executionContext.logicalTurnId ?? args.completion.turnId,
      results: plan.results,
      outcome,
      exempt: faults.exemptions(plan.sessionId, plan.runtimes),
      setupRuntimeIds: new Set(
        plan.runtimes.filter(isSetupRuntime).map((runtime) => runtime.name),
      ),
    });
    try {
      await faults.publish(
        transitions,
        plan.executionContext.origin === "player" ||
          plan.executionContext.origin === "continuation"
          ? args.emitter
          : undefined,
        args.eventBus,
        { traceId: args.emitter?.traceId, turnId: args.completion.turnId },
      );
    } catch (error) {
      console.warn("[plugin-faults] transition delivery failed", error);
    }
  }
  if (outcome.status === "committed") {
    scheduleMemoryIngest(args.memorySystem, args.execution.commit.sessionId);
  }
  return outcome;
}
