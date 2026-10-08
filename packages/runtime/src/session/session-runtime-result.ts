/**
 * Runtime result processing
 *
 * Internal module split from session-kernel.ts. Keep public imports routed
 * through session-kernel.ts unless a caller intentionally needs this boundary.
 */

import type { EventBus } from "@covel/events";
import type { Proposal, RuntimeEffects, SessionEvent } from "@covel/shared";
import type { HookPipeline } from "../hooks/pipeline.js";
import {
  createCommitPipeline,
  runPreStateCommitHook,
  type KernelStore,
} from "../commit/session-commit-pipeline.js";
import {
  malformedDomainEffect,
  normalizeOutput,
} from "../commit/session-output-normalizer.js";
import { makeProposal } from "./session-kernel-helpers.js";
import { anchorPluginMessage } from "../commit/plugin-message-turn.js";
import {
  enforceImageAssetOutput,
  enforceImagePluginDataRefs,
} from "../commit/session-asset-output.js";

export interface ProcessRuntimeResultOutput {
  /** SessionEvents from successfully committed proposals — ready to push to the client. */
  readonly events: SessionEvent[];
  /** Proposals that failed to commit. Empty when everything succeeds. */
  readonly failedProposals: ReadonlyArray<{
    readonly proposal: Proposal;
    readonly error: string;
  }>;
}

type FailedProposal = { readonly proposal: Proposal; readonly error: string };

/** The result shape every commit entry point accepts (top-level or nested). */
export interface CommittableRuntimeResult {
  pluginId: string;
  runtimeId: string;
  turnId: string;
  runId?: string;
  canonicalValue?: { readonly value?: import("@covel/shared").JsonValue };
  status: string;
  output: Record<string, unknown> | null;
  effects?: RuntimeEffects;
  pendingProposals?: readonly Proposal[];
  toolCalls?: ReadonlyArray<{ output?: unknown }>;
}

export interface RuntimeCommitOptions {
  readonly signal?: AbortSignal;
  readonly hookPipeline?: HookPipeline;
  readonly eventBus?: EventBus;
  readonly emitter?: import("../trace/turn-emitter.js").TurnEmitter;
  readonly enforceImageFlow?: boolean;
  /** Source content anchor supplied by the execution finalizer for retries. */
  readonly messageSourceTurnId?: string;
  /**
   * Optional commit-boundary policy for restricted execution classes such
   * as scheduler-detached jobs. Returning a message rejects the entire
   * proposal batch before any proposal reaches a commit handler.
   */
  readonly proposalGuard?: (proposal: Proposal) => string | undefined;
  /**
   * Commit barrier for callers running this inside their own store
   * transaction (passing a tx-bound view as `store`): externally-visible
   * fan-out (emitter events + PostStateCommit hooks) is handed to this
   * callback instead of firing inline, so the caller can flush it after its
   * transaction commits — or drop it on rollback.
   */
  readonly deferPostCommit?: (fn: () => Promise<void>) => void;
}

/** Proposals ready to persist, plus the ones already rejected on the way. */
export interface PreparedRuntimeProposals {
  readonly proposals: readonly Proposal[];
  readonly failedProposals: readonly FailedProposal[];
}

/**
 * Normalize one result into proposals and apply the image-flow checks.
 * `commit: false` means nothing of this result may be written.
 */
async function collectRuntimeProposals(
  result: CommittableRuntimeResult,
  store: KernelStore,
  sessionId: string,
  outputKind: string | undefined,
  opts: RuntimeCommitOptions | undefined,
): Promise<{
  readonly proposals: Proposal[];
  readonly failures: FailedProposal[];
  readonly commit: boolean;
}> {
  const source = { pluginId: result.pluginId, runtimeId: result.runtimeId };

  // Buffered domain writes attached to the result — by the agent tool loop
  // (success results) or a function-runtime / agent-guard write buffer. A
  // pre-game guard that wrote then returned `{ skip: true }` carries them on a
  // SKIPPED result. Tool/handler code could forge session/turn/source, so
  // rebind identity to the executing runtime before commit.
  const pendingProposals = (result.pendingProposals ?? []).map(
    (proposal) =>
      ({
        ...proposal,
        sessionId,
        turnId: result.turnId,
        source,
      }) as Proposal,
  );

  // Non-success results are not normalized — their output is not a committable
  // story/state output. Only a SKIPPED runtime (a pre-game guard that wrote
  // then returned skip:true) commits its buffered writes; a FAILED runtime
  // drops everything (its writes must not land), and a SUSPENDED runtime
  // stashes proposals in the suspension record instead.
  if (result.status !== "success" || !result.output) {
    const commit = result.status === "skipped" && pendingProposals.length > 0;
    return { proposals: commit ? pendingProposals : [], failures: [], commit };
  }

  // A malformed effect is a rejected write of this runtime, never a thrown
  // error: the finalizer isolates an optional runtime on a rejected write.
  const malformed = malformedDomainEffect(result.effects);
  if (malformed) {
    return {
      proposals: [],
      failures: [
        {
          proposal: makeProposal(
            malformed.type,
            source,
            result.turnId,
            sessionId,
            { error: malformed.error },
          ),
          error: malformed.error,
        },
      ],
      commit: false,
    };
  }

  const proposals = normalizeOutput(
    result.output,
    source,
    result.turnId,
    sessionId,
    outputKind,
    result.effects,
  );
  proposals.push(...pendingProposals);

  const failures: FailedProposal[] = [];
  const missingAssetFailure = await enforceImageAssetOutput(
    result,
    store,
    sessionId,
    proposals,
    opts?.enforceImageFlow,
  );
  if (missingAssetFailure) failures.push(missingAssetFailure);
  const inlineMediaFailures = await enforceImagePluginDataRefs(
    result,
    store,
    sessionId,
    proposals,
    opts?.enforceImageFlow,
  );
  failures.push(...inlineMediaFailures);
  if (inlineMediaFailures.length > 0 || proposals.length === 0) {
    return { proposals: [], failures, commit: false };
  }
  return { proposals, failures, commit: true };
}

/** Anchor plugin messages and apply the execution's proposal guard. */
function screenProposals(
  proposals: readonly Proposal[],
  opts: RuntimeCommitOptions | undefined,
): PreparedRuntimeProposals {
  const anchored = proposals.map((proposal) =>
    anchorPluginMessage(proposal, opts?.messageSourceTurnId),
  );
  if (opts?.proposalGuard) {
    const rejected = anchored.flatMap((proposal) => {
      const error = opts.proposalGuard?.(proposal);
      return error ? [{ proposal, error }] : [];
    });
    if (rejected.length > 0)
      return { proposals: [], failedProposals: rejected };
  }
  return { proposals: anchored, failedProposals: [] };
}

/**
 * Process a single RuntimeResult through the full Kernel pipeline:
 *   RuntimeResult → normalizeOutput → commitAll → SessionEvent[]
 *
 * This lower-level operation handles normalization, persistence, tracing,
 * and event generation for one result, running PreStateCommit hooks inline.
 * The execution finalizer instead uses {@link prepareRuntimeProposals} before
 * its transaction and {@link commitPreparedProposals} inside it.
 *
 * Returns a structured result with both successful events and failed proposals.
 * Returns empty arrays for failed/skipped runtimes.
 */
export async function processRuntimeResult(
  result: CommittableRuntimeResult,
  store: KernelStore,
  sessionId: string,
  outputKind?: string,
  opts?: RuntimeCommitOptions,
): Promise<ProcessRuntimeResultOutput> {
  const collected = await collectRuntimeProposals(
    result,
    store,
    sessionId,
    outputKind,
    opts,
  );
  if (!collected.commit) {
    return { events: [], failedProposals: collected.failures };
  }
  const screened = screenProposals(collected.proposals, opts);
  if (screened.failedProposals.length > 0) {
    return {
      events: [],
      failedProposals: [...collected.failures, ...screened.failedProposals],
    };
  }
  const committed = await persistProposals(
    screened.proposals,
    store,
    sessionId,
    result,
    opts,
    false,
  );
  return {
    events: committed.events,
    failedProposals: [...collected.failures, ...committed.failedProposals],
  };
}

/**
 * Everything before persistence for one result: normalization, image-flow
 * checks, retry anchoring, the proposal guard and PreStateCommit hooks. Reads
 * only committed state and writes nothing but diagnostics, so the finalizer
 * runs it before opening its transaction.
 */
export async function prepareRuntimeProposals(
  result: CommittableRuntimeResult,
  store: KernelStore,
  sessionId: string,
  outputKind: string | undefined,
  opts?: RuntimeCommitOptions,
): Promise<PreparedRuntimeProposals> {
  const collected = await collectRuntimeProposals(
    result,
    store,
    sessionId,
    outputKind,
    opts,
  );
  if (!collected.commit) {
    return { proposals: [], failedProposals: collected.failures };
  }
  const screened = screenProposals(collected.proposals, opts);
  if (screened.failedProposals.length > 0) {
    return {
      proposals: [],
      failedProposals: [...collected.failures, ...screened.failedProposals],
    };
  }
  if (!opts?.hookPipeline) {
    return {
      proposals: screened.proposals,
      failedProposals: collected.failures,
    };
  }
  const proposals: Proposal[] = [];
  const failedProposals: FailedProposal[] = [...collected.failures];
  for (const proposal of screened.proposals) {
    const hooked = await runPreStateCommitHook(opts.hookPipeline, proposal, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.eventBus ? { eventBus: opts.eventBus } : {}),
      ...(opts.emitter ? { emitter: opts.emitter } : {}),
    });
    if ("error" in hooked)
      failedProposals.push({ proposal, error: hooked.error });
    else proposals.push(hooked.proposal);
  }
  return { proposals, failedProposals };
}

/** Persist proposals produced by {@link prepareRuntimeProposals}. */
export function commitPreparedProposals(
  proposals: readonly Proposal[],
  store: KernelStore,
  sessionId: string,
  result: { readonly runtimeId: string; readonly turnId: string },
  opts?: RuntimeCommitOptions,
): Promise<ProcessRuntimeResultOutput> {
  return persistProposals(proposals, store, sessionId, result, opts, true);
}

/**
 * Commit a proposal list through the Kernel pipeline and collect the resulting
 * events / failures.
 */
async function persistProposals(
  proposals: readonly Proposal[],
  store: KernelStore,
  sessionId: string,
  result: { readonly runtimeId: string; readonly turnId: string },
  opts: RuntimeCommitOptions | undefined,
  preStateCommitApplied: boolean,
): Promise<ProcessRuntimeResultOutput> {
  // Thread the hook pipeline + eventBus through so PreStateCommit /
  // PostStateCommit actually run on real turn commits (previously these
  // hooks only fired in tests because callers didn't pass them).
  const pipeline = createCommitPipeline(
    store,
    opts?.hookPipeline,
    opts?.eventBus,
    opts?.emitter,
    opts?.signal,
    { preStateCommitApplied },
  );
  const commitResults = await pipeline.commitAll(
    proposals,
    opts?.deferPostCommit,
  );

  const events: SessionEvent[] = [];
  const failedProposals: FailedProposal[] = [];

  for (const [i, cr] of commitResults.entries()) {
    if (cr.committed && cr.event) {
      events.push(cr.event);
    } else if (!cr.committed) {
      failedProposals.push({
        proposal: proposals[i]!,
        error: cr.error ?? "unknown commit failure",
      });
    }
  }

  if (failedProposals.length > 0) {
    console.warn(
      "[session-kernel] processRuntimeResult: %d/%d proposals failed to commit for runtime %s (session %s, turn %s)",
      failedProposals.length,
      proposals.length,
      result.runtimeId,
      sessionId,
      result.turnId,
    );
    for (const fp of failedProposals) {
      console.warn(
        "[session-kernel]   failed proposal %s (type=%s): %s",
        fp.proposal.id,
        fp.proposal.type,
        fp.error,
      );
    }
  }

  return { events, failedProposals };
}
