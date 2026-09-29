/**
 * Read-through overlays over uncommitted proposals buffered earlier in the
 * SAME execution (agent tool loop or function-runtime handler/guard).
 *
 * Domain writes now flow through proposals that commit only at the end of the
 * execution. Without an overlay a runtime that writes a value and then reads it
 * back in the same execution sees the PRE-write state, so it either writes
 * twice or "corrects" a value that was already correct. These helpers let an
 * execution read its own buffered writes. Last write wins, matching the order
 * the commit pipeline applies them in.
 *
 * Scope: buffered proposals are per-execution — a single runtime's tool loop
 * or one function-runtime handler/guard. Cross-runtime same-turn reads are not
 * merged here (different runtimes carry different buffers).
 */

import {
  materializeCharacterUpsert,
  type CharacterRecord,
  type Proposal,
} from "@covel/shared";

export {
  overlayPluginDataValue,
  overlayPluginDataRows,
} from "@covel/plugin-handlers-utils";

/**
 * Materialize a session's committed characters and ordered buffered writes.
 * Versioned field patches compose over earlier patches; full upserts replace
 * the record. Return owned snapshots, never references into the store/buffer.
 * Characters are shared within a session, so no source-plugin filter applies.
 */
export function overlayCharacters(
  proposals: readonly Proposal[],
  stored: readonly CharacterRecord[],
  sessionId: string,
): Map<string, CharacterRecord> {
  const overlay = new Map(
    stored
      .filter((row) => row.sessionId === sessionId)
      .map((row) => [row.id, row]),
  );
  const now = new Date().toISOString();
  for (const proposal of proposals) {
    if (
      proposal.type === "character.upsert" &&
      proposal.sessionId === sessionId
    ) {
      overlay.set(
        proposal.payload.id,
        materializeCharacterUpsert(
          proposal.payload,
          overlay.get(proposal.payload.id),
          sessionId,
          now,
        ),
      );
    }
  }
  return structuredClone(overlay);
}
