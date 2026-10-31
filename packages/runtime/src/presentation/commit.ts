import { isDeepStrictEqual } from "node:util";
import {
  applyDataOps,
  dataOpsSchema,
  type JsonValue,
  type Proposal,
  type RuntimeManifest,
} from "@covel/shared";
import type { StoreTransaction } from "@covel/store";
import { createPresentationProposalGuard } from "./policy.js";
import { presentationMediaIds } from "./context.js";
import { presentationState } from "./state.js";

export function presentationCommitGuard(
  manifest: RuntimeManifest,
  result: object,
  outer?: (proposal: Proposal) => string | undefined,
) {
  const guard = createPresentationProposalGuard(manifest);
  const state = presentationState(result);
  return (proposal: Proposal) => {
    const error = guard(proposal) ?? outer?.(proposal);
    if (error) return error;
    if (!state?.snapshot.story)
      return "presentation has no public story source";
    if (
      [...presentationMediaIds(proposal.payload)].some(
        (id) => !state.mediaIds.has(id),
      )
    )
      return "presentation media is not reachable from its allowed assets";
    return undefined;
  };
}

/** Runs at the mutation boundary under the host's commit transaction/lock. */
export async function presentationSuperseded(
  tx: StoreTransaction,
  sessionId: string,
  result: object,
  proposals: readonly Proposal[],
): Promise<boolean> {
  const state = presentationState(result);
  if (!state?.snapshot.committed) return false;
  const touched = proposals.flatMap<{
    readonly namespace: string;
    readonly key: string;
  }>((proposal) =>
    proposal.type === "plugin.data.batch"
      ? proposal.payload.items
      : proposal.type === "plugin.data" ||
          proposal.type === "plugin.data.update" ||
          proposal.type === "plugin.data.delete"
        ? [proposal.payload]
        : [],
  );
  for (const { namespace, key } of touched) {
    const baseline = state.snapshot.baselines[namespace]?.find(
      (row) => row.key === key,
    );
    const current = await tx.getPluginData(
      sessionId,
      state.snapshot.pluginId,
      namespace,
      key,
    );
    if (
      Boolean(baseline) !== Boolean(current) ||
      (baseline &&
        current &&
        (baseline.updatedAt !== current.updatedAt ||
          !isDeepStrictEqual(baseline.value, current.value)))
    ) {
      state.reason = "superseded";
      return true;
    }
  }
  return false;
}

/** Check resulting values too: separate data operations can assemble a ref. */
export async function presentationMutationError(
  tx: StoreTransaction,
  sessionId: string,
  result: object,
  proposals: readonly Proposal[],
): Promise<string | undefined> {
  const state = presentationState(result);
  if (!state) return undefined;
  const values = new Map<
    string,
    { exists: true; value: JsonValue } | { exists: false }
  >();
  for (const proposal of proposals) {
    const items =
      proposal.type === "plugin.data.batch"
        ? proposal.payload.items
        : proposal.type === "plugin.data" ||
            proposal.type === "plugin.data.update" ||
            proposal.type === "plugin.data.delete"
          ? [proposal.payload]
          : [];
    for (const item of items) {
      const target = JSON.stringify([item.namespace, item.key]);
      let next: { exists: true; value: JsonValue } | { exists: false };
      if (proposal.type === "plugin.data.delete") next = { exists: false };
      else if (proposal.type === "plugin.data.update") {
        let current = values.get(target);
        if (!current) {
          const row = await tx.getPluginData(
            sessionId,
            state.snapshot.pluginId,
            item.namespace,
            item.key,
          );
          current = row
            ? { exists: true, value: row.value as JsonValue }
            : { exists: false };
        }
        const ops = dataOpsSchema.safeParse(proposal.payload.ops);
        if (!ops.success) continue; // Normal data validation reports malformed operations.
        const applied = applyDataOps(current, ops.data);
        if (!applied.ok) continue;
        next = applied.exists
          ? { exists: true, value: applied.value }
          : { exists: false };
      } else if ("value" in item)
        next = { exists: true, value: item.value as JsonValue };
      else continue;
      if (
        next.exists &&
        [...presentationMediaIds(next.value)].some(
          (id) => !state.mediaIds.has(id),
        )
      )
        return "presentation media is not reachable from its allowed assets";
      values.set(target, next);
    }
  }
  return undefined;
}
