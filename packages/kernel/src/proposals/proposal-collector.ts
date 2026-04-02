import type { KernelProposalEnvelope, KernelProposalItem } from "@covel/shared";

const VALID_KINDS: ReadonlySet<KernelProposalItem["kind"]> = new Set([
  "narrative.append",
  "state.patch",
  "event.emit",
  "record.upsert",
  "ui.render",
  "asset.generate",
]);

/**
 * Collect and normalize proposals from runtime executions into envelopes.
 */
export function createProposalCollector(turnContext: {
  runId: string;
  branchId: string;
  turnId: string;
  traceId: string;
}) {
  const envelopes: KernelProposalEnvelope[] = [];

  /**
   * Add proposals from a runtime execution.
   */
  function addFromRuntime(
    runtimeId: string,
    pluginId: string,
    proposals: Array<{ kind: string; payload: unknown }>
  ): void {
    if (proposals.length === 0) return;

    const items: KernelProposalItem[] = [];
    for (const p of proposals) {
      if (!VALID_KINDS.has(p.kind as KernelProposalItem["kind"])) {
        console.warn(
          `[proposal-collector] Skipping proposal with invalid kind "${p.kind}" from runtime "${runtimeId}" (plugin "${pluginId}")`
        );
        continue;
      }
      items.push({
        kind: p.kind as KernelProposalItem["kind"],
        payload: p.payload,
      });
    }

    if (items.length === 0) return;

    envelopes.push({
      proposalId: `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runId: turnContext.runId,
      branchId: turnContext.branchId,
      turnId: turnContext.turnId,
      runtimeId,
      pluginId,
      traceId: turnContext.traceId,
      items,
    });
  }

  /** Get all collected envelopes. */
  function getAll(): KernelProposalEnvelope[] {
    return envelopes;
  }

  return { addFromRuntime, getAll };
}

export type ProposalCollector = ReturnType<typeof createProposalCollector>;
