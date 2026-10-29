import type { PluginFaultReason, RuntimeResult } from "@covel/shared";
import type { FinalizeExecutionOutcome } from "../commit/finalize-execution.js";

export type PluginFaultVerdict =
  | { readonly kind: "fault"; readonly reason: PluginFaultReason }
  | { readonly kind: "clean" }
  | { readonly kind: "neutral" };

/** Attribute only direct faults, never a rolled-back sibling or dependent. */
export function classifyExecutionFaults(
  results: readonly Pick<
    RuntimeResult,
    "pluginId" | "runtimeId" | "runId" | "status" | "fault"
  >[],
  outcome: FinalizeExecutionOutcome,
  setupRuntimeIds: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, PluginFaultVerdict> {
  const verdicts = new Map<string, PluginFaultVerdict>();
  const put = (pluginId: string, verdict: PluginFaultVerdict) => {
    const previous = verdicts.get(pluginId);
    if (previous?.kind === "fault") return;
    if (verdict.kind !== "neutral" || !previous)
      verdicts.set(pluginId, verdict);
  };
  // Conflicts and stale suspension baselines are neutral for the entire attempt.
  if (outcome.code === "suspension-data-changed") return verdicts;
  for (const result of results) {
    if (setupRuntimeIds.has(result.runtimeId)) continue;
    const dropped = outcome.isolatedRuntimes?.some((item) =>
      item.runId === undefined
        ? item.runtimeId === result.runtimeId
        : item.runId === result.runId,
    );
    if (result.status === "failed" && result.fault) {
      put(result.pluginId, { kind: "fault", reason: result.fault });
    } else if (
      outcome.status === "committed" &&
      result.status === "success" &&
      !dropped
    ) {
      put(result.pluginId, { kind: "clean" });
    } else {
      put(result.pluginId, { kind: "neutral" });
    }
  }
  for (const failed of outcome.failedProposals) {
    if (
      failed.code === "dimension-version-conflict" ||
      failed.code === "hook-failed"
    )
      continue;
    if (setupRuntimeIds.has(failed.proposal.source.runtimeId)) continue;
    put(failed.proposal.source.pluginId, {
      kind: "fault",
      reason: "proposal-rejected",
    });
  }
  return verdicts;
}
