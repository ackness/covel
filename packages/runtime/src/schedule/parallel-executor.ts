/**
 * Parallel executor — runs same-priority runtimes concurrently with failure isolation.
 */

import type { RuntimeManifest, RuntimeResult } from "@covel/shared";

export type ParallelRuntimeIdentity = Pick<
  RuntimeResult,
  "pluginId" | "runtimeId" | "runId" | "turnId"
>;

/** A function that executes a single runtime and returns its result. */
export type RuntimeExecuteFn = (
  manifest: RuntimeManifest,
  identity: ParallelRuntimeIdentity,
) => Promise<RuntimeResult>;

/**
 * Execute a group of runtimes in parallel using Promise.allSettled.
 * Returns results keyed by runtime name.
 */
export async function executeParallel(
  runtimes: readonly RuntimeManifest[],
  executeFn: RuntimeExecuteFn,
  turnId: string,
): Promise<ReadonlyMap<string, RuntimeResult>> {
  const identities = runtimes.map((runtime): ParallelRuntimeIdentity => ({
    pluginId: runtime.pluginId ?? runtime.name.split("/")[0]!,
    runtimeId: runtime.name,
    runId: crypto.randomUUID(),
    turnId,
  }));
  const settled = await Promise.allSettled(
    runtimes.map((runtime, index) => executeFn(runtime, identities[index]!)),
  );

  const entries: Array<[string, RuntimeResult]> = runtimes.map((rt, i) => {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      return [rt.name, outcome.value];
    }
    const errorMessage =
      outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason);
    const failedResult: RuntimeResult = {
      ...identities[i]!,
      status: "failed",
      output: null,
      toolCalls: [],
      durationMs: 0,
      error: errorMessage,
      timestamp: new Date().toISOString(),
    };
    return [rt.name, failedResult];
  });

  return new Map(entries);
}
