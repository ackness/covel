import type { RuntimeManifest, RuntimeResult, TurnResult } from "@covel/shared";
import { executeParallel } from "./parallel-executor.js";

export type DeferredFollower = NonNullable<
  TurnResult["deferredFollowers"]
>[number];

export type EventChainRuntimeExecutor = (
  manifest: RuntimeManifest,
  triggerEvent:
    | { topic: string; data: Readonly<Record<string, unknown>> }
    | undefined,
) => Promise<RuntimeResult>;

export interface RunEventChainParams {
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly completedResults: Map<string, RuntimeResult>;
  readonly executeRuntime: EventChainRuntimeExecutor;
  readonly maxDepth?: number;
}

/**
 * Collect emitted runtime events into a topic -> payload map. First emission
 * wins inside a depth to keep fan-out deterministic.
 */
export function collectEventsFrom(
  result: RuntimeResult,
  sink: Map<string, Record<string, unknown>>,
): void {
  const output = result.output as Record<string, unknown> | null | undefined;
  const events = output?.events as Array<Record<string, unknown>> | undefined;
  if (!events) return;
  for (const evt of events) {
    const topic = evt?.topic;
    if (typeof topic !== "string" || topic.length === 0) continue;
    if (sink.has(topic)) continue;
    const data = (evt?.data as Record<string, unknown> | undefined) ?? {};
    sink.set(topic, data);
  }
}

export async function runEventChain({
  activeRuntimes,
  completedResults,
  executeRuntime,
  maxDepth = 8,
}: RunEventChainParams): Promise<DeferredFollower[]> {
  const emittedEvents = new Map<string, Record<string, unknown>>();
  for (const [, result] of completedResults) {
    collectEventsFrom(result, emittedEvents);
  }

  const deferredFollowers: DeferredFollower[] = [];
  let chainDepth = 0;
  while (emittedEvents.size > 0 && chainDepth < maxDepth) {
    chainDepth += 1;
    const nextBatch = activeRuntimes.filter((rt) => {
      if (completedResults.has(rt.name)) return false;
      if (rt.trigger?.type !== "event") return false;
      return (
        rt.trigger.topic !== undefined && emittedEvents.has(rt.trigger.topic)
      );
    });
    if (nextBatch.length === 0) break;

    const ordered = [...nextBatch].sort(
      (a, b) => (a.priority ?? 500) - (b.priority ?? 500),
    );

    const currentDepthEvents = new Map(emittedEvents);
    const newEvents = new Map<string, Record<string, unknown>>();
    const syncBatch: RuntimeManifest[] = [];

    for (const manifest of ordered) {
      const topic = manifest.trigger?.topic;
      const matchedEvent =
        topic !== undefined ? currentDepthEvents.get(topic) : undefined;
      if (
        manifest.execution === "background" &&
        topic !== undefined &&
        matchedEvent !== undefined
      ) {
        deferredFollowers.push({
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          triggerEvent: { topic, data: matchedEvent },
        });
        continue;
      }
      syncBatch.push(manifest);
    }

    if (syncBatch.length === 0) break;

    const results = await executeParallel(syncBatch, async (manifest) => {
      const topic = manifest.trigger?.topic;
      const matchedEvent =
        topic !== undefined ? currentDepthEvents.get(topic) : undefined;
      const triggerEvent =
        topic !== undefined && matchedEvent !== undefined
          ? { topic, data: matchedEvent }
          : undefined;
      return executeRuntime(manifest, triggerEvent);
    });
    for (const [name, result] of results) {
      completedResults.set(name, result);
      collectEventsFrom(result, newEvents);
    }

    emittedEvents.clear();
    for (const [topic, data] of newEvents) emittedEvents.set(topic, data);
  }

  return deferredFollowers;
}
