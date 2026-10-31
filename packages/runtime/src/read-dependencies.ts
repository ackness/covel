/**
 * Read dependencies between the results of one execution.
 *
 * A runtime reads its own plugin's data with the writes of completed upstream
 * runtimes of that plugin applied (`function-runtime/upstream-plugin-data.ts`).
 * World Model character/schema property reads share that recorder across
 * handlers, guards, tools and services, including cross-package producers.
 * Those writes are not committed yet. When one is dropped at commit, what a
 * reader built on it is stale, so the reader records which producer's writes
 * each read actually saw, and `finalizeExecution` drops an auxiliary reader
 * with its producer (a story or setup reader commits and is traced instead).
 *
 * Edges are keyed by a **producer id**: the `runId` of a result in the same
 * execution, or the id of a write-service operation whose staged writes the
 * read saw (`OperationRecord.id`). An operation commits at the end of its
 * caller's commit unit and can fail on its own, so finalize drops or traces
 * its readers like those of a dropped run. Nothing here assumes a producer
 * id names a run.
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
 * that can commit or owns a continuation; existing entries are kept. A
 * suspension is checked at its source commit before it can be saved. Its
 * producer graph is never stored in the continuation or replayed on resume.
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
