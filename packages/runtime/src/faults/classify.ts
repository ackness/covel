import type { PluginFaultReason, RuntimeResult } from "@covel/shared";
import type { FinalizeExecutionOutcome } from "../commit/finalize-execution.js";

export type PluginFaultVerdict =
  | { readonly kind: "fault"; readonly reason: PluginFaultReason }
  | { readonly kind: "clean" }
  | { readonly kind: "neutral" };

export interface SubagentRunOutcome {
  readonly pluginId: string;
  readonly callerRuntimeId: string;
  readonly ok: boolean;
  readonly fault?: "runtime" | "timeout";
}

/** Attribute only direct faults, never a rolled-back sibling or dependent. */
export function classifyExecutionFaults(
  results: readonly Pick<
    RuntimeResult,
    "pluginId" | "runtimeId" | "runId" | "status" | "fault"
  >[],
  outcome: FinalizeExecutionOutcome,
  setupRuntimeIds: ReadonlySet<string> = new Set(),
  subagentRuns: readonly SubagentRunOutcome[] = [],
  serviceCalls: readonly import("../plugin-services.js").ServiceCallOutcome[] = [],
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
  for (const run of subagentRuns) {
    if (setupRuntimeIds.has(run.callerRuntimeId)) continue;
    if (!run.ok && run.fault)
      put(run.pluginId, { kind: "fault", reason: run.fault });
    else if (run.ok && outcome.status === "committed")
      put(run.pluginId, { kind: "clean" });
    else put(run.pluginId, { kind: "neutral" });
  }
  for (const call of serviceCalls) {
    // A call a sub-agent made for a setup runtime is the setup's call.
    const scope = call.originRuntimeId ?? call.callerRuntimeId;
    if (scope && setupRuntimeIds.has(scope)) continue;
    if (call.verdict === "fault")
      put(call.providerPluginId, { kind: "fault", reason: "service" });
    else if (call.verdict === "clean" && outcome.status === "committed")
      put(call.providerPluginId, { kind: "clean" });
    else put(call.providerPluginId, { kind: "neutral" });
  }
  for (const failed of outcome.failedProposals) {
    if (
      failed.code === "dimension-version-conflict" ||
      failed.code === "conflict" ||
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
