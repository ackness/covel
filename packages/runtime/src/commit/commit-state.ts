/** Commit handler for `state.patch` — current value upsert + change log. */

import type { CommitResult, ProposalFor } from "@covel/shared";
import { makeEvent } from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import { firstFailure, requireNonEmptyString } from "./commit-validators.js";

export function createStateCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "state.patch"> {
  async function commitStatePatch(
    proposal: ProposalFor<"state.patch">,
  ): Promise<CommitResult> {
    const { table, field, value } = proposal.payload;
    // The payload types require table/field, but .js plugins bypass the type
    // layer and the output normalizer passes state.patch through untouched —
    // without this gate a malformed patch silently landed in "default"/"unknown".
    const invalid = firstFailure(
      requireNonEmptyString(
        table,
        "state.patch: table must be a non-empty string",
      ),
      requireNonEmptyString(
        field,
        "state.patch: field must be a non-empty string",
      ),
    );
    if (invalid) return invalid;
    // Update the current value AND append the change log, mirroring
    // StateManager.setValue. Without the upsertStateEntry, a committed
    // state.patch never changed the value that listStateEntries /
    // getTableSnapshot / fork snapshots read — the write was lost to every
    // current-value reader.
    await store.upsertStateEntry({
      id: crypto.randomUUID(),
      sessionId: proposal.sessionId,
      tableName: table,
      fieldName: field,
      value,
      updatedAt: proposal.timestamp,
    });
    await store.addStateChange({
      id: proposal.id,
      sessionId: proposal.sessionId,
      tableName: table,
      fieldName: field,
      value,
      changedBy: `${proposal.source.pluginId}/${proposal.source.runtimeId}`,
      turnId: proposal.turnId,
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("state.changed", proposal, { ...proposal.payload }),
    };
  }

  return { "state.patch": commitStatePatch };
}
