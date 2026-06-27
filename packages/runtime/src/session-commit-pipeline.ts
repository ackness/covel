/**
 * Proposal commit pipeline.
 */

import type { CommitResult, Proposal } from "@covel/shared";
import type { EventBus } from "@covel/events";
import type { HookPipeline } from "./hooks/pipeline.js";
import type { HookContext } from "./hooks/types.js";
import type { TurnEmitter } from "./turn-emitter.js";
import { createCommitHandlers } from "./session-commit-handlers.js";
import type { CommitHandler } from "./session-commit-handlers.js";
import { emitCommittedProposal } from "./session-commit-emitter.js";
export type { KernelStore } from "./session-kernel-store.js";
import type { KernelStore } from "./session-kernel-store.js";

/**
 * The Commit Pipeline: Proposal -> persist to Store -> emit SessionEvent.
 *
 * Every proposal type has a dedicated commit handler that knows how to
 * persist it and what event to emit. Unknown types are rejected.
 */
export interface CommitPipeline {
  commit(proposal: Proposal): Promise<CommitResult>;
  commitAll(proposals: readonly Proposal[]): Promise<CommitResult[]>;
}

export function createCommitPipeline(
  store: KernelStore,
  hookPipeline?: HookPipeline,
  eventBus?: EventBus,
  emitter?: TurnEmitter,
): CommitPipeline {
  const handlers = createCommitHandlers(store);

  async function commit(proposal: Proposal): Promise<CommitResult> {
    // `handlers` is a correlated map (each value expects its own proposal
    // variant). Dispatch by `proposal.type` is sound at runtime, so we erase
    // to the uniform `CommitHandler` here — the single, localized cast for the
    // whole commit chain. `| undefined` guards runtime-only invalid types
    // (e.g. a stale or malformed proposal whose type has no handler).
    const handler = (handlers as Record<string, CommitHandler | undefined>)[
      proposal.type
    ];
    if (!handler) {
      return {
        committed: false,
        error: `unknown proposal type: ${proposal.type}`,
      };
    }

    // Pipeline presence is the gate. Callers that don't want hooks pass
    // hookPipeline: undefined, such as tests for the bare commit path.
    let effectiveProposal = proposal;
    if (hookPipeline) {
      const hookCtx: HookContext = {
        event: "PreStateCommit",
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        pluginId: proposal.source.pluginId,
        runtimeId: proposal.source.runtimeId,
      };
      const preResult = await hookPipeline.run(
        "PreStateCommit",
        hookCtx,
        { proposal },
        { eventBus, emitter },
      );
      if (preResult.action === "abort") {
        return {
          committed: false,
          error: `pre-state-commit hook aborted: ${preResult.reason}`,
        };
      }
      if (
        preResult.action === "continue" &&
        "replace" in preResult &&
        preResult.replace?.proposal
      ) {
        effectiveProposal = preResult.replace.proposal as Proposal;
      }
    }

    const result = await handler(effectiveProposal);

    if (result.committed) {
      await store.addTraceEvent({
        id: crypto.randomUUID(),
        sessionId: effectiveProposal.sessionId,
        type: "proposal.committed",
        traceId: effectiveProposal.turnId,
        turnId: effectiveProposal.turnId,
        payload: {
          proposalType: effectiveProposal.type,
          proposalId: effectiveProposal.id,
          source: effectiveProposal.source,
        },
        createdAt: new Date().toISOString(),
      });
    }

    await emitCommittedProposal(emitter, effectiveProposal, result);

    if (hookPipeline && result.committed) {
      const hookCtx: HookContext = {
        event: "PostStateCommit",
        sessionId: effectiveProposal.sessionId,
        turnId: effectiveProposal.turnId,
        pluginId: effectiveProposal.source.pluginId,
        runtimeId: effectiveProposal.source.runtimeId,
      };
      await hookPipeline.run(
        "PostStateCommit",
        hookCtx,
        { proposal: effectiveProposal, result },
        { eventBus, emitter },
      );
    }

    return result;
  }

  async function commitAll(
    proposals: readonly Proposal[],
  ): Promise<CommitResult[]> {
    const supportsTx =
      typeof store.beginTx === "function" &&
      typeof store.commitTx === "function" &&
      typeof store.rollbackTx === "function";

    if (!supportsTx) {
      const results: CommitResult[] = [];
      for (const p of proposals) {
        results.push(await commit(p));
      }

      const committed = results.filter((r) => r.committed);
      const failed = results.filter((r) => !r.committed);
      if (committed.length > 0 && failed.length > 0) {
        const failureDetails = failed.map((r) => {
          const idx = results.indexOf(r);
          return {
            index: idx,
            type: proposals[idx].type,
            id: proposals[idx].id,
            error: r.error,
          };
        });
        console.warn(
          "[session-kernel] commitAll: partial commit detected (non-transactional mode) — %d committed, %d failed. Failures: %s",
          committed.length,
          failed.length,
          JSON.stringify(failureDetails),
        );
      }

      return results;
    }

    await store.beginTx!();
    try {
      const results: CommitResult[] = [];
      for (const p of proposals) {
        results.push(await commit(p));
      }
      await store.commitTx!();
      return results;
    } catch (err) {
      try {
        await store.rollbackTx!();
      } catch {
        // Surface the original failure to the caller.
      }
      throw err;
    }
  }

  return { commit, commitAll };
}
