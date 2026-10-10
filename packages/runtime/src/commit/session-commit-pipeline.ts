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
import { flushPostCommit } from "./post-commit-fanout.js";
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
  /**
   * Commit a proposal chain. `deferPostCommit`, when provided, receives the
   * externally-visible fan-out thunks (emitter events + PostStateCommit hooks)
   * instead of them running here — for callers that hold their own enclosing
   * transaction (they pass a tx-bound store view, which never exposes
   * `withTransaction`) and must flush fan-out only after THAT transaction
   * commits, discarding it on rollback.
   */
  commitAll(
    proposals: readonly Proposal[],
    deferPostCommit?: (fn: () => Promise<void>) => void,
  ): Promise<CommitResult[]>;
}

/**
 * Run the PreStateCommit hook for one proposal. A hook may veto the write or
 * rewrite its PAYLOAD only: the envelope — id, type, sessionId, turnId,
 * source — stays pinned to the original so a hook cannot redirect the write to
 * another session, another plugin's namespace, or a different proposal type
 * (which would also dodge the handler's schema validation).
 *
 * Hooks are plugin code with their own timeouts and read no store state, so
 * transactional callers run them before opening the transaction: a slow hook
 * must never hold the store's write gate.
 */
export async function runPreStateCommitHook(
  hookPipeline: HookPipeline,
  proposal: Proposal,
  opts: {
    readonly signal?: AbortSignal;
    readonly eventBus?: EventBus;
    readonly emitter?: TurnEmitter;
  } = {},
): Promise<{ readonly proposal: Proposal } | { readonly error: string }> {
  const hookCtx: HookContext = {
    event: "PreStateCommit",
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    pluginId: proposal.source.pluginId,
    runtimeId: proposal.source.runtimeId,
    signal: opts.signal,
  };
  const preResult = await hookPipeline.run(
    "PreStateCommit",
    hookCtx,
    { proposal },
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
  // Parent cancellation stops the whole batch, including later proposals.
  opts.signal?.throwIfAborted();
  if (preResult.action === "abort") {
    return { error: `pre-state-commit hook aborted: ${preResult.reason}` };
  }
  if (
    preResult.action === "continue" &&
    "replace" in preResult &&
    preResult.replace?.proposal
  ) {
    const replacement = preResult.replace.proposal as Proposal;
    return {
      proposal: { ...proposal, payload: replacement.payload } as Proposal,
    };
  }
  return { proposal };
}

export interface CommitPipelineOptions {
  /**
   * The caller already ran {@link runPreStateCommitHook} for every proposal,
   * outside its transaction. PostStateCommit still runs after commit.
   */
  readonly preStateCommitApplied?: boolean;
}

export function createCommitPipeline(
  store: KernelStore,
  hookPipeline?: HookPipeline,
  eventBus?: EventBus,
  emitter?: TurnEmitter,
  signal?: AbortSignal,
  options: CommitPipelineOptions = {},
): CommitPipeline {
  const handlers = createCommitHandlers(store);

  function commit(proposal: Proposal): Promise<CommitResult> {
    return commitWith(handlers, store, proposal);
  }

  /**
   * Commit a single proposal through `handlerMap`, recording the trace event
   * via `writeStore`. An already transaction-bound path passes its current
   * view; a root-store path opens and passes a new `tx`-scoped view (and tx-bound
   * handlers) so every write lands inside the open transaction — critical on
   * PostgreSQL, where `withTransaction` runs on an isolated connection and a
   * write through the outer store would escape the transaction.
   *
   * `defer` is the commit barrier: when provided (transactional mode), the
   * externally-visible fan-out for this proposal — live SSE/trace events via
   * the emitter and the PostStateCommit hook — is buffered instead of run
   * inline, so a later proposal throwing (→ ROLLBACK) can never leave clients
   * having seen "committed" events for data that no longer exists.
   */
  async function commitWith(
    handlerMap: CommitHandlerMap,
    writeStore: KernelStore,
    proposal: Proposal,
    defer?: (fn: () => Promise<void>) => void,
    preStateCommitApplied = options.preStateCommitApplied ?? false,
  ): Promise<CommitResult> {
    signal?.throwIfAborted();
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
    if (hookPipeline && !preStateCommitApplied) {
      const hooked = await runPreStateCommitHook(hookPipeline, proposal, {
        signal,
        eventBus,
        emitter,
      });
      if ("error" in hooked) return { committed: false, error: hooked.error };
      effectiveProposal = hooked.proposal;
    }

    const result = await handler(effectiveProposal);

    if (result.committed) {
      await writeStore.addTraceEvent({
        id: crypto.randomUUID(),
        sessionId: effectiveProposal.sessionId,
        type: "proposal.committed",
        // Correlate with the SSE stream's traceId (carried by the per-turn
        // emitter) instead of falling back to turnId, so /api/traces?traceId=
        // returns emitter + commit rows under one id.
        traceId: emitter?.traceId ?? effectiveProposal.turnId,
        turnId: effectiveProposal.turnId,
        payload: {
          proposalType: effectiveProposal.type,
          proposalId: effectiveProposal.id,
          source: effectiveProposal.source,
        },
        createdAt: new Date().toISOString(),
      });
    }

    // Externally-visible fan-out. In transactional mode this runs only after
    // the transaction COMMITs (deferred by commitAll); PostStateCommit rides
    // the same barrier — its contract is "the state IS committed", which is
    // only true once the enclosing transaction has resolved.
    const runPostCommit = async (): Promise<void> => {
      // Manual/background RPC has no action stream. Publish committed UI on
      // the persistent state subscription, behind the same rollback barrier.
      const event = result.event;
      if (
        result.committed &&
        event &&
        (event.type === "interaction.requested" ||
          event.type === "ui.rendered" ||
          event.type === "dimensions.changed" ||
          event.type === "dimensions.settlement.changed")
      ) {
        eventBus?.emit({
          id: event.id,
          type: "event",
          topic: "state",
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          payload: {
            ...event.payload,
            turnId: event.turnId,
            _subType: event.type,
          },
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
    };

    if (defer) {
      defer(runPostCommit);
    } else {
      await runPostCommit();
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
              type: proposals[idx]?.type,
              id: proposals[idx]?.id,
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
    deferPostCommit?: (fn: () => Promise<void>) => void,
  ): Promise<CommitResult[]> {
    // Preferred path: a single scoped transaction. The callback writes through
    // the tx-bound store view (and tx-bound handlers), so a thrown store error
    // rolls back every write in the chain. NOTE this is not proposal-level
    // atomicity: a handler validation failure returns { committed: false }
    // without throwing, the transaction still commits, and committed siblings
    // stay. On PostgreSQL each
    // `withTransaction` runs on its own pooled connection, so concurrent turns
    // no longer serialize behind a shared begin/commit window.
    if (typeof store.withTransaction === "function") {
      // Commit barrier (audit): externally-visible fan-out (emitter
      // events + PostStateCommit hooks) is buffered while the transaction is
      // open and flushed only after it COMMITs. A thrown store error discards
      // the buffer along with the rollback — clients never see events for
      // rolled-back data.
      const postCommit: Array<() => Promise<void>> = [];
      // PreStateCommit runs before the transaction opens; a vetoed proposal
      // keeps its slot as a failed result without reaching a handler.
      const screened: Array<
        { readonly proposal: Proposal } | { readonly error: string }
      > = [];
      for (const p of proposals) {
        screened.push(
          hookPipeline && !options.preStateCommitApplied
            ? await runPreStateCommitHook(hookPipeline, p, {
                signal,
                eventBus,
                emitter,
              })
            : { proposal: p },
        );
      }
      const results = await store.withTransaction(async (tx) => {
        const txHandlers = createCommitHandlers(tx, { singleBatch: true });
        const txResults: CommitResult[] = [];
        for (const entry of screened) {
          txResults.push(
            "error" in entry
              ? { committed: false, error: entry.error }
              : await commitWith(
                  txHandlers,
                  tx,
                  entry.proposal,
                  (fn) => postCommit.push(fn),
                  true,
                ),
          );
        }
        signal?.throwIfAborted();
        return txResults;
      });
      // Transaction committed — flush in proposal order. A failing emit/hook
      // must not masquerade as a commit failure (the data IS committed), so
      // each thunk is isolated and surfaced as a warning. A caller-supplied
      // barrier takes over the flush: its own commit point is strictly later.
      if (deferPostCommit) {
        for (const fn of postCommit) deferPostCommit(fn);
      } else {
        const sessionId = proposals[0]?.sessionId;
        if (sessionId !== undefined)
          await flushPostCommit(postCommit, {
            sessionId,
            label: "session-kernel",
            ...(eventBus ? { eventBus } : {}),
            ...(emitter ? { emitter } : {}),
          });
      }
      warnPartialCommit(proposals, results, "transactional mode");
      return results;
    }

    // A tx-bound store view from a caller-owned enclosing transaction omits
    // `withTransaction` because nesting is rejected. Commit directly through
    // that view; the caller passes `deferPostCommit`
    // so fan-out waits behind its commit instead of firing while the outer
    // transaction is still open (and could still roll these writes back).
    // The outer transaction still owns rollback; surface handler-level partial
    // results so the caller can decide whether to abort that transaction.
    // PreStateCommit runs between the records unless the caller ran it
    // beforehand; only then is the batch the sole writer for its whole length.
    const batchHandlers = options.preStateCommitApplied
      ? createCommitHandlers(store, { singleBatch: true })
      : handlers;
    const results: CommitResult[] = [];
    for (const p of proposals) {
      results.push(await commitWith(batchHandlers, store, p, deferPostCommit));
    }
    warnPartialCommit(proposals, results, "enclosing transaction");
    return results;
  }

  return { commit, commitAll };
}
