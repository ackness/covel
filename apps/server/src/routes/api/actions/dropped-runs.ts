import type { CovelEvent, RuntimeResult } from "@covel/shared";
import type { IsolatedRuntime } from "@covel/runtime";

type RuntimeFailedPayload = Extract<
  CovelEvent,
  { readonly type: "runtime.failed" }
>["payload"];

/** A `runtime.failed` correction, with the identity of the run it settles. */
export type DroppedRunPayload = {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly status: "failed";
  readonly durationMs: number;
  readonly error: string;
};

/**
 * Corrections for runs already streamed as completed whose writes were
 * dropped at commit, top-level or nested. The client keeps one step per
 * runtime in a turn, so a dropped nested run is not reported while a
 * top-level run of the same runtime committed: its correction would mark
 * the run that did commit as failed.
 */
export function droppedRunPayloads(
  result: {
    readonly runtimeResults: readonly RuntimeResult[];
    readonly nestedRuntimeResults?: readonly RuntimeResult[];
  },
  isolated: readonly IsolatedRuntime[] | undefined,
): DroppedRunPayload[] {
  if (!isolated?.length) return [];
  const topLevel = result.runtimeResults;
  const runs = [...topLevel, ...(result.nestedRuntimeResults ?? [])];
  const matches = (run: RuntimeResult, item: IsolatedRuntime) =>
    item.runId !== undefined
      ? run.runId === item.runId
      : run.runtimeId === item.runtimeId;
  const droppedRuns = new Set(
    runs.filter((run) => isolated.some((item) => matches(run, item))),
  );
  return isolated.flatMap((item) => {
    const dropped = runs.find((run) => matches(run, item));
    if (!dropped) return [];
    const shadowsCommittedRun =
      !topLevel.includes(dropped) &&
      topLevel.some(
        (run) => run.runtimeId === dropped.runtimeId && !droppedRuns.has(run),
      );
    if (shadowsCommittedRun) return [];
    const payload: DroppedRunPayload = {
      runtimeId: dropped.runtimeId,
      pluginId: dropped.pluginId,
      turnId: dropped.turnId,
      runId: dropped.runId,
      status: "failed",
      durationMs: dropped.durationMs,
      error: item.error,
    };
    return [payload satisfies RuntimeFailedPayload];
  });
}
