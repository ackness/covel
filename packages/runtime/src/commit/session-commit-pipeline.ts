/**
 * Proposal commit pipeline.
 */

import type { CommitResult, Proposal } from "@covel/shared";
import type { EventBus } from "@covel/events";
import type { HookPipeline } from "../hooks/pipeline.js";
import type { HookContext } from "../hooks/types.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import { createCommitHandlers } from "./session-commit-handlers.js";
import type {
  CommitHandler,
  CommitHandlerMap,
} from "./session-commit-handlers.js";
import { emitCommittedProposal } from "./session-commit-emitter.js";
export type { KernelStore } from "../session/session-kernel-store.js";
import type { KernelStore } from "../session/session-kernel-store.js";

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

  function commit(proposal: Proposal): Promise<CommitResult> {
    return commitWith(handlers, store, proposal);
  }

  /**
   * Commit a single proposal through `handlerMap`, recording the trace event
   * via `writeStore`. The non-transactional path passes the outer `store`; the
   * transactional path passes the `tx`-scoped store view (and tx-bound
   * handlers) so every write lands inside the open transaction — critical on
   * PostgreSQL, where `withTransaction` runs on an isolated connection and a
   * write through the outer store would escape the transaction.
   */
  async function commitWith(
    handlerMap: CommitHandlerMap,
    writeStore: KernelStore,
    proposal: Proposal,
  ): Promise<CommitResult> {
    // `handlerMap` is a correlated map (each value expects its own proposal
    // variant). Dispatch by `proposal.type` is sound at runtime, so we erase
    // to the uniform `CommitHandler` here — the single, localized cast for the
    // whole commit chain. `| undefined` guards runtime-only invalid types
    // (e.g. a stale or malformed proposal whose type has no handler).
    const handler = (handlerMap as Record<string, CommitHandler | undefined>)[
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
      await writeStore.addTraceEvent({
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

  /**
   * Warn loudly when a commitAll batch lands partially: some proposals
   * committed while siblings were rejected. In BOTH modes this is the
   * expected best-effort semantics — a handler *validation* failure returns
   * `{ committed: false }` without throwing, so it never rolls back committed
   * siblings; only a thrown store error aborts (and, in transactional mode,
   * rolls back) the whole chain.
   */
  function warnPartialCommit(
    proposals: readonly Proposal[],
    results: readonly CommitResult[],
    mode: string,
  ): void {
    const committed = results.filter((r) => r.committed).length;
    const failures = results.flatMap((r, idx) =>
      r.committed
        ? []
        : [
            {
              index: idx,
              type: proposals[idx].type,
              id: proposals[idx].id,
              error: r.error,
            },
          ],
    );
    if (committed === 0 || failures.length === 0) return;
    console.warn(
      "[session-kernel] commitAll: partial commit detected (%s) — %d committed, %d failed. Failures: %s",
      mode,
      committed,
      failures.length,
      JSON.stringify(failures),
    );
  }

  async function commitAll(
    proposals: readonly Proposal[],
  ): Promise<CommitResult[]> {
    // Preferred path: a single scoped transaction. The callback writes through
    // the tx-bound store view (and tx-bound handlers), so a thrown store error
    // rolls back every write in the chain. NOTE this is not proposal-level
    // atomicity: a handler validation failure returns { committed: false }
    // without throwing, the transaction still commits, and committed siblings
    // stay — same best-effort semantics as the fallback below (kept identical
    // deliberately so all store backends behave the same). On PostgreSQL each
    // `withTransaction` runs on its own pooled connection, so concurrent turns
    // no longer serialize behind a shared begin/commit window.
    if (typeof store.withTransaction === "function") {
      const results = await store.withTransaction(async (tx) => {
        const txHandlers = createCommitHandlers(tx);
        const txResults: CommitResult[] = [];
        for (const p of proposals) {
          txResults.push(await commitWith(txHandlers, tx, p));
        }
        return txResults;
      });
      warnPartialCommit(proposals, results, "transactional mode");
      return results;
    }

    // Fallback: stores without scoped transactions (thin mocks / legacy
    // backends) commit one proposal at a time. A mid-chain failure can leave a
    // partial commit, so surface it loudly.
    const results: CommitResult[] = [];
    for (const p of proposals) {
      results.push(await commit(p));
    }
    warnPartialCommit(proposals, results, "non-transactional mode");
    return results;
  }

  return { commit, commitAll };
}
