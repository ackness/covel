/**
 * Read dependencies between the results of one execution.
 *
 * A runtime reads its own plugin's data with the writes of completed upstream
 * runtimes of that plugin applied (`function-runtime/upstream-plugin-data.ts`).
 * Those writes are not committed yet. When one is dropped at commit, what a
 * reader built on it is stale, so the reader records which producer's writes
 * each read actually saw, and `finalizeExecution` drops an auxiliary reader
 * with its producer (a story or setup reader commits and is traced instead).
 *
 * Edges are keyed by a **producer id**. Today a producer id is always the
 * `runId` of a result in the same execution. Story-attached operations
 * will commit as units that are not runs, and readers of their staged writes
 * must cascade too; they will add producer ids that are not runs, and finalize
 * will need a second source of dropped producers. Nothing here assumes a
 * producer id names a run.
 *
 * Like the execution journal, the edges ride on the reader's result under a
 * non-enumerable symbol, so `structuredClone` and JSON keep them out of
 * persisted and transported artifacts. Symbols do not survive the commit
 * plan's `structuredClone`, so `executeTurn` collects them into the plan with
 * {@link collectExecutionReadDependencies}; finalize never reads the symbol.
 */

import type { RuntimeResult, TurnResult } from "@covel/shared";

const READ_DEPENDENCIES = Symbol.for("@covel/runtime/read-dependencies");

type ReadDependencyCarrier = RuntimeResult & {
  readonly [READ_DEPENDENCIES]?: readonly string[];
};

/** Producer ids whose uncommitted writes one invocation's reads saw. */
export type ReadRecorder = Set<string>;

export function createReadRecorder(): ReadRecorder {
  return new Set();
}

/** The producer ids a result's reads depended on. */
export function readDependenciesOf(result: RuntimeResult): readonly string[] {
  return (result as ReadDependencyCarrier)[READ_DEPENDENCIES] ?? [];
}

/**
 * Record that `result` read writes of `producerIds`. Call only for a result
 * that can commit; existing entries are kept.
 */
export function attachReadDependencies(
  result: RuntimeResult,
  producerIds: Iterable<string>,
): RuntimeResult {
  const merged = new Set([...readDependenciesOf(result), ...producerIds]);
  if (merged.size === 0) return result;
  Object.defineProperty(result, READ_DEPENDENCIES, {
    value: [...merged],
    enumerable: false,
    configurable: true,
  });
  return result;
}

/**
 * Every read dependency of one execution, by reader `runId`. Nested results
 * are included: they ride on their parent's result and are listed in
 * `nestedRuntimeResults`.
 */
export function collectExecutionReadDependencies(
  turnResult: Pick<TurnResult, "runtimeResults" | "nestedRuntimeResults">,
): Record<string, string[]> {
  const edges: Record<string, string[]> = {};
  for (const result of new Set([
    ...turnResult.runtimeResults,
    ...(turnResult.nestedRuntimeResults ?? []),
  ])) {
    const producers = readDependenciesOf(result);
    if (producers.length > 0) edges[result.runId] = [...producers];
  }
  return edges;
}
