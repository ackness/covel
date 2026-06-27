/**
 * Runtime result processing
 *
 * Internal module split from session-kernel.ts. Keep public imports routed
 * through session-kernel.ts unless a caller intentionally needs this boundary.
 */

import { getPendingProposals } from "@covel/tools";
import type { EventBus } from "@covel/events";
import type { Proposal, SessionEvent } from "@covel/shared";
import type { HookPipeline } from "../hooks/pipeline.js";
import {
  createCommitPipeline,
  type KernelStore,
} from "../commit/session-commit-pipeline.js";
import { normalizeOutput } from "../commit/session-output-normalizer.js";
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

/**
 * Process a single RuntimeResult through the full Kernel pipeline:
 *   RuntimeResult → normalizeOutput → commitAll → SessionEvent[]
 *
 * This is the single entry point that actions.ts should call for each
 * runtime result. It handles: normalization, persistence, tracing,
 * and event generation.
 *
 * Returns a structured result with both successful events and failed proposals.
 * Returns empty arrays for failed/skipped runtimes.
 */
export async function processRuntimeResult(
  result: {
    pluginId: string;
    runtimeId: string;
    turnId: string;
    status: string;
    output: Record<string, unknown> | null;
    toolCalls?: ReadonlyArray<{ output?: unknown }>;
  },
  store: KernelStore,
  sessionId: string,
  outputKind?: string,
  opts?: {
    readonly hookPipeline?: HookPipeline;
    readonly eventBus?: EventBus;
    readonly emitter?: import("../trace/turn-emitter.js").TurnEmitter;
    readonly capabilities?: readonly string[];
  },
): Promise<ProcessRuntimeResultOutput> {
  const empty: ProcessRuntimeResultOutput = { events: [], failedProposals: [] };

  // Skip failed/skipped runtimes — nothing to commit
  if (result.status !== "success" || !result.output) {
    return empty;
  }

  const source = { pluginId: result.pluginId, runtimeId: result.runtimeId };
  const proposals = normalizeOutput(
    result.output,
    source,
    result.turnId,
    sessionId,
    outputKind,
    result.toolCalls,
  );
  proposals.push(...getPendingProposals(result.output));

  const imageGenerationFailures: Array<{ proposal: Proposal; error: string }> =
    [];
  const missingAssetFailure = await enforceImageAssetOutput(
    result,
    store,
    sessionId,
    proposals,
    opts?.capabilities,
  );
  if (missingAssetFailure) {
    imageGenerationFailures.push(missingAssetFailure);
  }
  const inlineMediaFailures = await enforceImagePluginDataRefs(
    result,
    store,
    sessionId,
    proposals,
    opts?.capabilities,
  );
  imageGenerationFailures.push(...inlineMediaFailures);
  if (inlineMediaFailures.length > 0) {
    return { events: [], failedProposals: imageGenerationFailures };
  }

  if (proposals.length === 0) {
    return {
      events: [],
      failedProposals: imageGenerationFailures,
    };
  }

  // Thread the hook pipeline + eventBus through so PreStateCommit /
  // PostStateCommit actually run on real turn commits (previously these
  // hooks only fired in tests because callers didn't pass them).
  const pipeline = createCommitPipeline(
    store,
    opts?.hookPipeline,
    opts?.eventBus,
    opts?.emitter,
  );
  const commitResults = await pipeline.commitAll(proposals);

  const events: SessionEvent[] = [];
  const failedProposals: Array<{ proposal: Proposal; error: string }> = [];

  for (let i = 0; i < commitResults.length; i++) {
    const cr = commitResults[i];
    if (cr.committed && cr.event) {
      events.push(cr.event);
    } else if (!cr.committed) {
      failedProposals.push({
        proposal: proposals[i],
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

  return {
    events,
    failedProposals: [...imageGenerationFailures, ...failedProposals],
  };
}
