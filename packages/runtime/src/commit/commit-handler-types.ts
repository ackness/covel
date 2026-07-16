/**
 * Commit-handler registry types.
 *
 * The handler registry is keyed by `ProposalType` via `CommitHandlerMap`, so
 * adding a proposal type to `ProposalPayloadMap` (in @covel/shared) forces a
 * matching handler — a missing handler is a compile error, never a silent
 * `unknown proposal type` failure at runtime. Each handler receives a
 * `ProposalFor<K>`, so `proposal.payload` is already the precise payload type
 * (no `as XxxPayload` casts required).
 */

import type {
  CommitResult,
  Proposal,
  ProposalFor,
  ProposalType,
} from "@covel/shared";

/** A commit handler narrowed to a single proposal type. */
export type CommitHandlerFor<K extends ProposalType> = (
  proposal: ProposalFor<K>,
) => Promise<CommitResult>;

/**
 * Exhaustive registry shape: every `ProposalType` must have a handler.
 * `createCommitHandlers` returns this type, so omitting a handler fails to
 * compile.
 */
export type CommitHandlerMap = {
  [K in ProposalType]: CommitHandlerFor<K>;
};

/**
 * Type-erased handler used at the dispatch site. The pipeline looks a handler
 * up by `proposal.type` and invokes it with the full `Proposal` union; this is
 * the canonical correlated-union escape hatch (a single cast in the pipeline,
 * never inside individual handlers).
 */
export type CommitHandler = (proposal: Proposal) => Promise<CommitResult>;
