/**
 * Output finalization for the agent tool-call loop.
 *
 * Both the normal execution path (`executeAgentRuntime`) and the resume path
 * (`resumeSuspendedRuntime`) end the same way: turn the loop's final content +
 * executed tool calls into separate business output and runtime effects. This module owns that
 * shared transform so the two paths cannot drift apart again (they had — resume
 * was a hand-copied, slowly diverging clone of the main finalize block).
 *
 * The transform:
 *   1. Build the envelope from finalContent (parsed) or the last presentable /
 *      structured tool output, or fail when only failed tool calls remain.
 *   2. Run the shared schema gate between build and decoration when a private
 *      output schema is declared. A gate hit short-circuits finalize.
 *   3. Extract declared and tool-emitted effects, sanitize story narrative,
 *      attach buffered proposals to the business output.
 */

import type {
  JsonValue,
  Proposal,
  RuntimeEffects,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
} from "@covel/shared";
import { storyOutputError } from "./story-output.js";
import type { EmittedEvent } from "@covel/tools";
import { collectUiBlocks } from "../session/session-kernel-helpers.js";
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
  /** Prefer this completing-tool result over incidental assistant prose. */
  readonly preferredOutput?: Record<string, unknown>;
  readonly executedToolCalls: readonly ExecutedToolCallState[];
  /** Tool results persisted before a suspension, unavailable in executedToolCalls. */
  readonly priorToolCalls?: readonly ToolCallRecord[];
  readonly failedToolCalls: readonly FailedToolCallState[];
  readonly pendingProposals: readonly Proposal[];
  /** Events emitted via `emit-event` tool calls — appended to `effects.events`. */
  readonly emittedEvents?: readonly EmittedEvent[];
  /** Dedupe repeated tool interactions by `interactionId`. */
  readonly dedupeInteractions?: boolean;
  /**
   * Optional schema gate, invoked after any candidate output has been
   * converted into the output envelope. Returning a failed
   * RuntimeResult short-circuits finalize; the caller is responsible for any
   * telemetry + PostRuntime wrapping.
   */
  readonly schemaGate?: (args: {
    readonly output: Record<string, unknown>;
    readonly parsedAsJson: boolean;
    readonly finalContent: string | null;
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
  | {
      readonly kind: "ok";
      readonly output: Record<string, unknown>;
      readonly pendingProposals?: readonly Proposal[];
      readonly effects?: RuntimeEffects;
      readonly completion?: "done" | "pending";
    }
  | { readonly kind: "tool-failed" }
  | { readonly kind: "invalid-output"; readonly error: string }
  | { readonly kind: "short-circuit"; readonly result: RuntimeResult };

export function finalizeAgentOutput(
  params: FinalizeAgentOutputParams,
): FinalizeAgentOutput {
  const {
    manifest,
    finalContent,
    preferredOutput,
    executedToolCalls,
    priorToolCalls = [],
    failedToolCalls,
    pendingProposals,
    emittedEvents = [],
    dedupeInteractions = false,
    schemaGate,
  } = params;

  const presentable = findPresentableToolOutput(executedToolCalls);
  const structured = findLastStructuredToolOutput(executedToolCalls);

  let output: Record<string, unknown>;
  let parsedAsJson = true;
  let schemaFinalContent: string | null = null;
  if (preferredOutput) {
    output = { ...preferredOutput };
  } else if (finalContent) {
    const parsed = parseFinalOutputEnvelope(finalContent);
    parsedAsJson = parsed.parsedAsJson;
    schemaFinalContent = finalContent;
    const suppressNarrative = shouldSuppressToolLoopNarrative({
      outputKind: manifest.outputKind,
      executedToolCalls,
      parsedAsJson: parsed.parsedAsJson,
    });
    // Preparation prose cannot turn a failed form/write tool into empty success.
    if (
      suppressNarrative &&
      !structured &&
      !presentable &&
      failedToolCalls.length
    )
      return { kind: "tool-failed" };
    output = suppressNarrative
      ? (structured ?? presentable ?? { narrativeOutput: "" })
      : parsed.output;
  } else if (failedToolCalls.length > 0) {
    return { kind: "tool-failed" };
  } else {
    output = presentable ?? { narrativeOutput: "" };
  }

  if (schemaGate) {
    const failed = schemaGate({
      output,
      parsedAsJson,
      finalContent: schemaFinalContent,
    });
    if (failed) return { kind: "short-circuit", result: failed };
  }

  const declaredEvents = Array.isArray(output.events) ? output.events : [];
  const effectEvents = declaredEvents.filter(isEffectEvent);
  if (effectEvents.length > 0) {
    const businessEvents = declaredEvents.filter(
      (event) => !isEffectEvent(event),
    );
    if (businessEvents.length > 0) output.events = businessEvents;
    else delete output.events;
  }

  // An envelope-declared event precedes a tool-emitted event with the same
  // topic, preserving the turn-event-chain's first-wins order.
  const effects: Record<string, unknown> = {};
  if (effectEvents.length > 0 || emittedEvents.length > 0) {
    effects.events = [...effectEvents, ...emittedEvents];
  }

  // A resumed loop starts its executedToolCalls afresh; earlier successful
  // tool outputs survive only as ToolCallRecords. Failed calls have null or
  // diagnostic-string outputs, so only record-shaped results can supply UI.
  const priorToolResults = priorToolCalls
    .filter(
      (call) =>
        call.output !== null &&
        typeof call.output === "object" &&
        !Array.isArray(call.output),
    )
    .map((call) => ({
      name: call.toolName,
      result: call.output,
      success: true,
    }));
  const toolResults = [...priorToolResults, ...executedToolCalls];
  const toolInteractions = extractInteractions(
    toolResults,
    dedupeInteractions,
    manifest.name,
  );
  const declaredInteractions = Array.isArray(output.interactions)
    ? output.interactions
    : [];
  const interactions =
    toolInteractions.length > 0 ? toolInteractions : declaredInteractions;
  if (interactions.length > 0) {
    effects.interactions = interactions;
    if (finalContent && !parsedAsJson && !output.narrativeOutput) {
      output.narrativeOutput = finalContent;
    }
  }
  delete output.interactions;
  delete output.interaction;

  const ui = collectUiBlocks(
    output,
    toolResults
      .filter((call) => call.success)
      .map((call) => ({ output: call.result })),
  );
  if (ui.length > 0) effects.ui = ui;
  delete output.ui;

  for (const key of [
    "statePatches",
    "assetGenerations",
    "pluginData",
    "notifications",
  ] as const) {
    if (Array.isArray(output[key])) effects[key] = output[key];
    delete output[key];
  }

  const completion =
    output.preGameDone === true || output.completion === "done"
      ? "done"
      : output.completion === "pending"
        ? "pending"
        : undefined;
  delete output.preGameDone;
  if (completion) delete output.completion;

  if (
    manifest.outputKind === "story" &&
    typeof output.narrativeOutput === "string"
  ) {
    output.narrativeOutput = sanitizeStoryNarrativeText(output.narrativeOutput);
  }

  const storyError =
    manifest.outputKind === "story" ? storyOutputError(output) : undefined;
  if (storyError) return { kind: "invalid-output", error: storyError };
  return {
    kind: "ok",
    output,
    ...(pendingProposals.length > 0
      ? { pendingProposals: [...pendingProposals] }
      : {}),
    ...(Object.keys(effects).length > 0
      ? { effects: effects as RuntimeEffects }
      : {}),
    ...(completion ? { completion } : {}),
  };
}

function isEffectEvent(value: unknown): value is JsonValue {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "topic" in value
  );
}

/**
 * Collect `interaction` payloads from executed tool results. When `dedupe` is
 * set, drop repeats sharing an `interactionId` (keeping the first occurrence)
 * so a UI tool the LLM called twice does not render twice.
 */
function extractInteractions(
  executedToolCalls: readonly Pick<
    ExecutedToolCallState,
    "name" | "result" | "success"
  >[],
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
