/** Assemble accepted model output and independently owned business effects. */
import { isBusinessTool } from "./runtime-completion.js";
import type {
  JsonValue,
  Proposal,
  RuntimeEffects,
  RuntimeManifest,
} from "@covel/shared";
import { normalizeStoryOutput, STORY_EMPTY_ERROR } from "./story-output.js";
import type { EmittedEvent } from "@covel/tools";
import { collectUiBlocks } from "../session/session-kernel-helpers.js";
import { type ExecutedToolCallState } from "../turn-executor/turn-output-helpers.js";

export interface FinalizeAgentOutputParams {
  readonly manifest: RuntimeManifest;
  /** Validated model-authored submission; its fields cannot produce effects. */
  readonly acceptedOutput: Readonly<Record<string, unknown>>;
  readonly executedToolCalls: readonly ExecutedToolCallState[];
  readonly pendingProposals: readonly Proposal[];
  /** Events emitted via `emit-event` tool calls — appended to `effects.events`. */
  readonly emittedEvents?: readonly EmittedEvent[];
  /** Dedupe repeated tool interactions by `interactionId`. */
  readonly dedupeInteractions?: boolean;
}

export type FinalizeAgentOutput =
  | {
      readonly kind: "ok";
      readonly output: Record<string, unknown>;
      readonly pendingProposals?: readonly Proposal[];
      readonly effects?: RuntimeEffects;
      readonly completion?: "done" | "pending";
    }
  | {
      readonly kind: "invalid-output";
      readonly error: string;
      readonly problems: readonly string[];
    };

export function finalizeAgentOutput(
  params: FinalizeAgentOutputParams,
): FinalizeAgentOutput {
  const {
    manifest,
    acceptedOutput,
    executedToolCalls,
    pendingProposals,
    emittedEvents = [],
    dedupeInteractions = false,
  } = params;
  let output: Record<string, unknown> = structuredClone(acceptedOutput);
  dropModelAuthoredEffects(output, manifest.name);
  const effects: Record<string, unknown> = {};
  if (emittedEvents.length) effects.events = [...emittedEvents];

  const toolResults = executedToolCalls.filter((call) =>
    isBusinessTool(call.name),
  );
  const toolInteractions = extractInteractions(toolResults, dedupeInteractions);
  if (toolInteractions.length) effects.interactions = toolInteractions;
  const successfulTools = toolResults.filter((call) => call.success);
  const ui = collectUiBlocks(
    {},
    successfulTools.map((call) => ({ output: call.result })),
  );
  if (ui.length) effects.ui = ui;
  for (const call of successfulTools) {
    if (
      !call.result ||
      typeof call.result !== "object" ||
      Array.isArray(call.result)
    )
      continue;
    const result = call.result as Record<string, unknown>;
    for (const key of [
      "assetGenerations",
      "pluginData",
      "notifications",
    ] as const) {
      if (Array.isArray(result[key]))
        effects[key] = [...((effects[key] as unknown[]) ?? []), ...result[key]];
    }
    if (Array.isArray(result.events)) {
      const events = result.events.filter(isEffectEvent);
      if (events.length)
        effects.events = [...events, ...((effects.events as unknown[]) ?? [])];
    }
  }

  const completion =
    output.preGameDone === true || output.completion === "done"
      ? "done"
      : output.completion === "pending"
        ? "pending"
        : undefined;
  delete output.preGameDone;
  if (completion) delete output.completion;

  if (manifest.outputKind === "story") {
    const story = normalizeStoryOutput(output);
    if (!story)
      return {
        kind: "invalid-output",
        error: STORY_EMPTY_ERROR,
        problems: ["the story text is empty"],
      };
    output = story;
  }

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

/** Fields stripped and warned about in model-authored JSON. */
const EFFECT_FIELDS = [
  "statePatches", // Removed writes still need an author warning in model-authored JSON.
  "interactions",
  "interaction",
  "ui",
  "assetGenerations",
  "pluginData",
  "notifications",
] as const;

/**
 * Remove what would become an effect from JSON the model wrote. Business
 * events (no `topic`) stay in `output.events`.
 */
function dropModelAuthoredEffects(
  output: Record<string, unknown>,
  runtimeName: string,
  silent = false,
): void {
  const dropped: string[] = EFFECT_FIELDS.filter((key) => key in output);
  for (const key of dropped) delete output[key];
  if (Array.isArray(output.events) && output.events.some(isEffectEvent)) {
    const business = output.events.filter((event) => !isEffectEvent(event));
    if (business.length > 0) output.events = business;
    else delete output.events;
    dropped.push("events[].topic");
  }
  if (dropped.length > 0 && !silent)
    console.warn(
      `[runtime] ${runtimeName} wrote ${dropped.join(", ")} in its final JSON; an agent's final output carries no effects, so they were ignored. Write through a tool listed in agent.tools.`,
    );
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
 * set, keep the last successful revision of each `interactionId`, so a model
 * can correct a form after reading its preview without showing two forms.
 */
function extractInteractions(
  executedToolCalls: readonly Pick<
    ExecutedToolCallState,
    "name" | "result" | "success"
  >[],
  dedupe: boolean,
): Array<Record<string, unknown>> {
  const interactions: Array<Record<string, unknown>> = [];
  const interactionPositions = new Map<string, number>();
  for (const tc of executedToolCalls) {
    if (!(tc.success && tc.result && typeof tc.result === "object")) continue;
    const r = tc.result as Record<string, unknown>;
    if (!(r.interaction && typeof r.interaction === "object")) continue;
    const inter = r.interaction as Record<string, unknown>;
    if (dedupe) {
      const id =
        typeof inter.interactionId === "string" ? inter.interactionId : "";
      const position = id ? interactionPositions.get(id) : undefined;
      if (position !== undefined) {
        interactions[position] = inter;
        continue;
      }
      if (id) interactionPositions.set(id, interactions.length);
    }
    interactions.push(inter);
  }
  return interactions;
}
