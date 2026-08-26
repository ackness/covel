/**
 * Execution-local suspension continuations.
 *
 * Runtime execution creates these artifacts, while the commit-owning caller
 * collects and persists them through `finalizeExecution`. A non-enumerable
 * symbol keeps continuation state out of serialized RuntimeResult payloads.
 */

import type { TurnResult } from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";

const EXECUTION_SUSPENSIONS = Symbol.for(
  "@covel/runtime/execution-suspensions",
);

export interface SuspensionArtifact {
  readonly record: SuspensionRecord;
}

type SuspensionCarrier = object & {
  readonly [EXECUTION_SUSPENSIONS]?: readonly SuspensionArtifact[];
};

export function attachSuspensionArtifact<T extends object>(
  carrier: T,
  artifact: SuspensionArtifact,
): T {
  const existing =
    (carrier as SuspensionCarrier)[EXECUTION_SUSPENSIONS] ??
    ([] as readonly SuspensionArtifact[]);
  Object.defineProperty(carrier, EXECUTION_SUSPENSIONS, {
    value: [...existing, artifact],
    enumerable: false,
    configurable: true,
  });
  return carrier;
}

function artifactsOf(carrier: object): readonly SuspensionArtifact[] {
  return (carrier as SuspensionCarrier)[EXECUTION_SUSPENSIONS] ?? [];
}

/** Collect and de-duplicate every continuation created by one execution. */
export function collectExecutionSuspensions(
  turnResult: Pick<TurnResult, "runtimeResults" | "nestedRuntimeResults">,
): readonly SuspensionRecord[] {
  const all = [
    ...artifactsOf(turnResult),
    ...turnResult.runtimeResults.flatMap((result) => artifactsOf(result)),
    ...(turnResult.nestedRuntimeResults ?? []).flatMap((result) =>
      artifactsOf(result),
    ),
  ];
  const seen = new Set<string>();
  return all.flatMap(({ record }) => {
    if (seen.has(record.id)) return [];
    seen.add(record.id);
    return [record];
  });
}
