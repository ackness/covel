/** Commit handler for `event.emit` — persists game events. */

import type { CommitResult, ProposalFor } from "@covel/shared";
import { makeEvent } from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import { requireNonEmptyString } from "./commit-validators.js";

export function createEventCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "event.emit"> {
  async function commitEvent(
    proposal: ProposalFor<"event.emit">,
  ): Promise<CommitResult> {
    const { topic, data } = proposal.payload;
    const invalid = requireNonEmptyString(
      topic,
      "event.emit: topic must be a non-empty string",
    );
    if (invalid) return invalid;
    await store.saveEvent({
      id: proposal.id,
      sessionId: proposal.sessionId,
      type: "game",
      topic,
      payload: data ?? {},
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("event.emitted", proposal, { ...proposal.payload }),
    };
  }

  return { "event.emit": commitEvent };
}
