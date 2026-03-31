import type { KernelProposalEnvelope, KernelProposalItem } from "@covel/shared";

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

    const items: KernelProposalItem[] = proposals.map((p) => ({
      kind: p.kind as KernelProposalItem["kind"],
      payload: p.payload,
    }));

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
