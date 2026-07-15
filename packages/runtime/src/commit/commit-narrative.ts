/** Commit handler for `narrative.append` — persists narrative messages. */

import type { CommitResult, ProposalFor } from "@covel/shared";
import { makeEvent } from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";

export function createNarrativeCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "narrative.append"> {
  async function commitNarrative(
    proposal: ProposalFor<"narrative.append">,
  ): Promise<CommitResult> {
    const { content, kind } = proposal.payload;
    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: kind === "system" ? "system" : "assistant",
      content,
      metadata: {
        turnId: proposal.turnId,
        runtimeId: proposal.source.runtimeId,
        kind,
      },
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("narrative.completed", proposal, {
        content,
        kind,
        messageId: proposal.id,
      }),
    };
  }

  return { "narrative.append": commitNarrative };
}
