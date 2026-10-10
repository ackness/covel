import type { RuntimeResult } from "@covel/shared";

/** The runtime results of a stored turn row, which the store keeps as JSON. */
export function runtimeResultsOf(row: {
  readonly runtimeResults: unknown;
}): readonly RuntimeResult[] {
  return row.runtimeResults as readonly RuntimeResult[];
}
