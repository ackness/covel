/**
 * Kernel-held results of `ctx.recursiveCall`.
 *
 * A nested execution has no commit path of its own: its results belong to the
 * invocation that started it. They wait in that invocation's scope and ride on
 * its result only when its own handler succeeds, the same rule as the
 * execution write buffer, so a parent that fails drops its children's writes
 * with its own. Deeper levels compose: a grandchild rides on the child.
 *
 * The originals ride under a non-enumerable symbol, like the execution
 * journal, so `structuredClone` and JSON keep them out of persisted and
 * transported artifacts. Plugin code only ever receives a copy.
 */

import type { RuntimeResult } from "@covel/shared";

const NESTED_RESULTS = Symbol.for("@covel/runtime/nested-results");

type NestedCarrier = RuntimeResult & {
  readonly [NESTED_RESULTS]?: readonly RuntimeResult[];
};

function childrenOf(result: RuntimeResult): readonly RuntimeResult[] {
  return (result as NestedCarrier)[NESTED_RESULTS] ?? [];
}

/** Let `nested` commit with `result`. Call only once the parent succeeded. */
export function attachNestedResults(
  result: RuntimeResult,
  nested: readonly RuntimeResult[],
): RuntimeResult {
  if (nested.length === 0) return result;
  Object.defineProperty(result, NESTED_RESULTS, {
    value: [...childrenOf(result), ...nested],
    enumerable: false,
    configurable: true,
  });
  return result;
}

/**
 * Commit order: every result preceded by the results nested under it,
 * children before their parent, so upstreams settle before what depends on
 * them. The order of `results` themselves is kept.
 */
export function inCommitOrder(
  results: readonly RuntimeResult[],
): RuntimeResult[] {
  return results.flatMap((result) => [
    ...inCommitOrder(childrenOf(result)),
    result,
  ]);
}

/**
 * The size of each result's commit unit in {@link inCommitOrder}: the result
 * itself plus everything nested under it. A unit commits or drops as one.
 */
export function commitUnitSizes(results: readonly RuntimeResult[]): number[] {
  return results.map((result) => inCommitOrder([result]).length);
}

/** Every result nested under `results`, at any depth, in commit order. */
export function nestedResultsOf(
  results: readonly RuntimeResult[],
): RuntimeResult[] {
  return results.flatMap((result) => inCommitOrder(childrenOf(result)));
}
