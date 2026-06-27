/**
 * Output finalization for the agent tool-call loop.
 *
 * Both the normal execution path (`executeAgentRuntime`) and the resume path
 * (`resumeSuspendedRuntime`) end the same way: turn the loop's final content +
 * executed tool calls into the runtime's `output` object. This module owns that
 * shared transform so the two paths cannot drift apart again (they had — resume
 * was a hand-copied, slowly diverging clone of the main finalize block).
 *
 * The transform:
 *   1. Build the envelope from finalContent (parsed) or the last presentable /
 *      structured tool output, or fail when only failed tool calls remain.
 *   2. (optional) Run a schema gate between build and decoration — the main
 *      path uses it for prose-failure + schema-validation checks; resume skips
 *      it. A gate hit short-circuits finalize.
 *   3. Decorate: attach interactions, sanitize story narrative, attach buffered
 *      proposals.
 */

import type { Proposal, RuntimeManifest, RuntimeResult } from "@covel/shared";
import { withPendingProposals } from "@covel/tools";
import {
  findLastStructuredToolOutput,
  findPresentableToolOutput,
  parseFinalOutputEnvelope,
  sanitizeStoryNarrativeText,
  shouldSuppressToolLoopNarrative,
  type ExecutedToolCallState,
  type FailedToolCallState,
} from "../turn-executor/turn-output-helpers.js";

export interface FinalizeAgentOutputParams {
  readonly manifest: RuntimeManifest;
  readonly finalContent: string | null;
  readonly executedToolCalls: readonly ExecutedToolCallState[];
  readonly failedToolCalls: readonly FailedToolCallState[];
  readonly pendingProposals: readonly Proposal[];
  /**
   * Dedupe interactions by `interactionId`. The main agent path enables this so
   * the LLM calling the same UI tool twice does not render duplicate forms; the
   * resume path keeps its historical pass-through behaviour (off by default).
   */
  readonly dedupeInteractions?: boolean;
  /**
   * Optional schema gate, invoked only when `finalContent` is present and after
   * the envelope `output` is built. Returning a failed RuntimeResult
   * short-circuits finalize; the caller is responsible for any telemetry +
   * PostRuntime wrapping. Resume passes none (no schema enforcement on resume).
   */
  readonly schemaGate?: (args: {
    readonly output: Record<string, unknown>;
    readonly parsedAsJson: boolean;
    readonly finalContent: string;
  }) => RuntimeResult | undefined;
}

/**
 * Result of {@link finalizeAgentOutput}:
 *  - `ok` — the decorated runtime output object.
 *  - `tool-failed` — no final content and only failed tool calls; the caller
 *    builds the `tool_failed_without_output` failure result.
 *  - `short-circuit` — the schema gate produced a failed RuntimeResult.
 */
export type FinalizeAgentOutput =
  | { readonly kind: "ok"; readonly output: Record<string, unknown> }
  | { readonly kind: "tool-failed" }
  | { readonly kind: "short-circuit"; readonly result: RuntimeResult };

export function finalizeAgentOutput(
  params: FinalizeAgentOutputParams,
): FinalizeAgentOutput {
  const {
    manifest,
    finalContent,
    executedToolCalls,
    failedToolCalls,
    pendingProposals,
    dedupeInteractions = false,
    schemaGate,
  } = params;

  const presentable = findPresentableToolOutput(executedToolCalls);
  const structured = findLastStructuredToolOutput(executedToolCalls);

  let output: Record<string, unknown>;
  if (finalContent) {
    const parsed = parseFinalOutputEnvelope(finalContent);
    output = shouldSuppressToolLoopNarrative({
      outputKind: manifest.outputKind,
      executedToolCalls,
      parsedAsJson: parsed.parsedAsJson,
    })
      ? (structured ?? presentable ?? { narrativeOutput: "" })
      : parsed.output;
    if (schemaGate) {
      const failed = schemaGate({
        output,
        parsedAsJson: parsed.parsedAsJson,
        finalContent,
      });
      if (failed) return { kind: "short-circuit", result: failed };
    }
  } else if (failedToolCalls.length > 0) {
    return { kind: "tool-failed" };
  } else {
    output = presentable ?? { narrativeOutput: "" };
  }

  const interactions = extractInteractions(
    executedToolCalls,
    dedupeInteractions,
    manifest.name,
  );
  if (interactions.length > 0) {
    output.interactions = interactions;
    if (finalContent && !output.narrativeOutput) {
      output.narrativeOutput = finalContent;
    }
  }

  if (
    manifest.outputKind === "story" &&
    typeof output.narrativeOutput === "string"
  ) {
    output.narrativeOutput = sanitizeStoryNarrativeText(output.narrativeOutput);
  }

  if (pendingProposals.length > 0) {
    output = withPendingProposals(output, pendingProposals) as Record<
      string,
      unknown
    >;
  }

  return { kind: "ok", output };
}

/**
 * Collect `interaction` payloads from executed tool results. When `dedupe` is
 * set, drop repeats sharing an `interactionId` (keeping the first occurrence)
 * so a UI tool the LLM called twice does not render twice.
 */
function extractInteractions(
  executedToolCalls: readonly ExecutedToolCallState[],
  dedupe: boolean,
  runtimeName: string,
): Array<Record<string, unknown>> {
  const interactions: Array<Record<string, unknown>> = [];
  const seenInteractionIds = new Set<string>();
  for (const tc of executedToolCalls) {
    if (!(tc.success && tc.result && typeof tc.result === "object")) continue;
    const r = tc.result as Record<string, unknown>;
    if (!(r.interaction && typeof r.interaction === "object")) continue;
    const inter = r.interaction as Record<string, unknown>;
    if (dedupe) {
      const id =
        typeof inter.interactionId === "string" ? inter.interactionId : "";
      if (id && seenInteractionIds.has(id)) {
        console.warn(
          `[runtime] ${runtimeName} produced duplicate interactionId="${id}" via tool "${tc.name}"; keeping the first occurrence`,
        );
        continue;
      }
      if (id) seenInteractionIds.add(id);
    }
    interactions.push(inter);
  }
  return interactions;
}
