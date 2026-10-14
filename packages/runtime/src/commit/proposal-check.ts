/**
 * The check every proposal passes before its commit handler runs.
 *
 * 1. The payload must match the schema of its type
 *    (`proposalPayloadSchemas` in @covel/shared) and be JSON. It continues as
 *    its JSON copy, so every backend stores the same value.
 * 2. Every MediaRef in it is canonicalized against the session (when the
 *    commit has a media store): an asset that does not exist, that the
 *    session does not reference, or whose mime differs rejects the proposal;
 *    a stored ref has the store's mime and size and no `url`.
 *
 * A failure is a rejected proposal (`{ committed: false }`), so the commit
 * takes its failure path: the finalizer drops the runtime's writes, or the
 * whole execution when it cannot isolate the runtime.
 */

import {
  checkProposalPayload,
  type JsonValue,
  type Proposal,
} from "@covel/shared";
import {
  canonicalizeMediaRefs,
  type MediaOwnershipStore,
} from "../media/canonicalize-media-refs.js";

export type ProposalCheck =
  | { readonly proposal: Proposal }
  | { readonly error: string; readonly code: string };

export async function checkCommitProposal(
  proposal: Proposal,
  mediaStore: MediaOwnershipStore | undefined,
): Promise<ProposalCheck> {
  const checked = checkProposalPayload(proposal.type, proposal.payload);
  if (!checked.ok) return { error: checked.error, code: "proposal-invalid" };
  // Both copies below hold the payload the schema of this type accepted.
  const withPayload = (payload: unknown) =>
    ({ ...proposal, payload }) as Proposal;
  const json: unknown = checked.payload;
  if (!mediaStore) return { proposal: withPayload(json) };
  const media = await canonicalizeMediaRefs(json as JsonValue, {
    store: mediaStore,
    sessionId: proposal.sessionId,
  });
  const [first] = media.rejections;
  if (first) {
    return {
      error: `${proposal.type}: ${media.rejections.map((rejection) => rejection.message).join("; ")}`,
      code: first.reason,
    };
  }
  for (const diagnostic of media.diagnostics) {
    console.warn(
      `[commit] ${proposal.type} from ${proposal.source.runtimeId}: ${diagnostic.message}`,
    );
  }
  return { proposal: withPayload(media.value) };
}
