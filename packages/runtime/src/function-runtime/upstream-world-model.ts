import type { Proposal, RuntimeResult } from "@covel/shared";
import { malformedDomainEffect } from "../commit/session-output-normalizer.js";
import { commitEligibility } from "../session/session-runtime-result.js";
import { inCommitOrder } from "../turn-executor/nested-results.js";

/** A visible world proposal and its kernel-held producing invocation. */
export interface UpstreamWorldWrite {
  readonly runId: string;
  readonly runtimeId: string;
  readonly proposal: Proposal;
}

/**
 * Snapshot committable world writes in commit order, across package boundaries.
 * Seeds and their descendants already settled in another execution.
 */
export function collectUpstreamWorldWrites(
  results: ReadonlyMap<string, RuntimeResult>,
  sessionId: string,
  seeds?: ReadonlySet<RuntimeResult>,
): readonly UpstreamWorldWrite[] {
  return structuredClone(
    [...results.values()]
      .filter(
        (root) =>
          !seeds?.has(root) &&
          commitEligibility(root) !== "none" &&
          !malformedDomainEffect(root.effects),
      )
      .flatMap((root) => inCommitOrder([root]))
      .flatMap((result) => {
        if (
          commitEligibility(result) === "none" ||
          malformedDomainEffect(result.effects)
        )
          return [];
        return (result.pendingProposals ?? [])
          .filter(
            (proposal) =>
              proposal.type === "character.upsert" ||
              proposal.type === "character.schema.set" ||
              proposal.type === "dimension.initialize" ||
              proposal.type === "dimension.update",
          )
          .map((proposal) => ({
            runId: result.runId,
            runtimeId: result.runtimeId,
            proposal: {
              ...proposal,
              sessionId,
              turnId: result.turnId,
              source: {
                pluginId: result.pluginId,
                runtimeId: result.runtimeId,
              },
            } as Proposal,
          }));
      }),
  );
}
