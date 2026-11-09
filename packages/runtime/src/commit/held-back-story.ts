/**
 * Whether a story the framework held back can let its action commit.
 *
 * A held-back story wrote nothing. When that is because a runtime it hard
 * depends on failed in this execution, the action is in the same state as one
 * whose story failed: committing would count the turn and keep the other
 * runtimes' writes, with no narrative. When the gate stayed closed because
 * the package itself chose not to run an upstream (its trigger, cadence or
 * guard), nothing broke, and the execution commits as it does after the
 * story's own guard skips it. Rejecting there would also stop the clock that
 * a cadence-gated upstream waits on, so no later turn could open the gate.
 */

import { getRuntimeSpec, type RuntimeManifest } from "@covel/shared";
import type { FinalizableResult } from "./finalize-types.js";

interface ExecutionView {
  readonly runtimes: readonly RuntimeManifest[];
  readonly results: readonly FinalizableResult[];
}

interface Lookup {
  readonly runtimes: readonly RuntimeManifest[];
  /** The last result of each runtime: the one its consumers saw. */
  readonly resultOf: ReadonlyMap<string, FinalizableResult>;
}

/** How the `needs` gate names a contract in `missingUpstreams`. */
const CAPABILITY_PREFIX = "capability:";

/** The framework gate that held `result` back, if a framework gate did. */
function frameworkGateOf(result: FinalizableResult): string | undefined {
  if (result.status !== "skipped") return undefined;
  // A guard skip (`skip: true`) or a PreRuntime veto (no `skippedBy`) is the
  // plugin's or a hook's decision, not a gate.
  const by = result.output?.skippedBy;
  return result.output?.skipped === true && typeof by === "string"
    ? by
    : undefined;
}

function providersOf(contract: string, lookup: Lookup): string[] {
  return lookup.runtimes
    .filter((runtime) => runtime.outputContract === contract)
    .map((runtime) => runtime.name);
}

/**
 * The upstreams that kept `result`'s gate closed, as the gate saw them. A
 * fault in any of them is part of why the runtime did not run.
 *
 * Only the gates that wait on this execution's upstreams are traced. The
 * setup gate waits for the player to finish the plugin's setup, and
 * rejecting would also discard the setup's own writes (its form). A
 * dependency cycle holds back the cycle and everything after it, `after`
 * edges included, so a cycle in another package would stop every turn;
 * validation and traces report it to the author. Export bindings read what
 * earlier executions committed.
 */
function closedUpstreamsOf(
  result: FinalizableResult,
  lookup: Lookup,
): readonly string[] {
  const output = result.output ?? {};
  switch (frameworkGateOf(result)) {
    case "framework:needs": {
      const missing = Array.isArray(output.missingUpstreams)
        ? output.missingUpstreams.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      // A contract is missing only when its cardinality was not met: no
      // provider succeeded (`one`), or not every provider did (`all`).
      return missing.flatMap((entry) =>
        entry.startsWith(CAPABILITY_PREFIX)
          ? providersOf(entry.slice(CAPABILITY_PREFIX.length), lookup)
          : [entry],
      );
    }
    case "framework:inputBinding": {
      // The gate records only its reason. Every other reason is about the
      // value or a missing provider, not a runtime that failed.
      if (output.reason !== "upstream-failed") return [];
      const manifest = lookup.runtimes.find(
        (runtime) => runtime.name === result.runtimeId,
      );
      if (!manifest) return [];
      return Object.values(getRuntimeSpec(manifest).bindings)
        .filter((binding) => binding.required !== false)
        .flatMap((binding) => {
          if ("runtime" in binding.from) return [binding.from.runtime];
          const providers = providersOf(binding.from.capability, lookup);
          // A `one` input is met by any provider that succeeded.
          const met =
            (binding.from.cardinality ?? "one") === "one" &&
            providers.some(
              (name) => lookup.resultOf.get(name)?.status === "success",
            );
          return met ? [] : providers;
        });
    }
    default:
      return [];
  }
}

/** The runtime whose failure held `result` back, if one did. */
function failedBehind(
  result: FinalizableResult,
  lookup: Lookup,
  visited: Set<string>,
): string | undefined {
  // A success, a suspension (its resume settles the turn), a guard skip or a
  // hook veto has no closed upstream, so it is not a fault.
  if (result.status === "failed") return result.runtimeId;
  if (visited.has(result.runtimeId)) return undefined;
  visited.add(result.runtimeId);
  for (const upstream of closedUpstreamsOf(result, lookup)) {
    // No result: the runtime was not scheduled; its trigger or cadence chose
    // not to run it this turn.
    const upstreamResult = lookup.resultOf.get(upstream);
    const failed =
      upstreamResult && failedBehind(upstreamResult, lookup, visited);
    if (failed) return failed;
  }
  return undefined;
}

/**
 * The error that refuses the action when `story` was held back because a
 * runtime it hard depends on failed in this execution, or `undefined` when it
 * may commit.
 */
export function heldBackStoryError(
  story: FinalizableResult,
  view: ExecutionView,
): string | undefined {
  if (frameworkGateOf(story) === undefined) return undefined;
  const lookup: Lookup = {
    runtimes: view.runtimes,
    resultOf: new Map(view.results.map((result) => [result.runtimeId, result])),
  };
  const failed = failedBehind(story, lookup, new Set());
  return failed
    ? `Story runtime ${story.runtimeId} did not run because ${failed} failed; the action was not committed.`
    : undefined;
}
