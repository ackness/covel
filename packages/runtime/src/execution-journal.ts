/**
 * Execution-scoped conversation journal.
 *
 * Player/runtime TurnMessages are collected while the turn runs and appended
 * by `finalizeExecution` inside the same transaction as proposals and the
 * session clock. Symbols keep the pending journal out of persisted runtime /
 * turn-result artifacts while preserving it across the in-process handoff to
 * the commit-owning caller.
 */

import {
  getRuntimeSpec,
  stageMessageOrder,
  type RuntimeManifest,
  type RuntimeResult,
  type TurnInput,
  type TurnResult,
} from "@covel/shared";
import type { TurnMessageRecord } from "@covel/store";

const EXECUTION_JOURNAL = Symbol.for("@covel/runtime/execution-journal");
const RUNTIME_TRIGGER = Symbol.for("@covel/runtime/runtime-trigger");

type JournalCarrier = object & {
  readonly [EXECUTION_JOURNAL]?: readonly TurnMessageRecord[];
  readonly [RUNTIME_TRIGGER]?: string;
};

export function attachExecutionJournal<T extends object>(
  carrier: T,
  messages: readonly TurnMessageRecord[],
): T {
  if (messages.length === 0) return carrier;
  const existing =
    (carrier as JournalCarrier)[EXECUTION_JOURNAL] ??
    ([] as readonly TurnMessageRecord[]);
  Object.defineProperty(carrier, EXECUTION_JOURNAL, {
    value: [...existing, ...messages],
    enumerable: false,
    configurable: true,
  });
  return carrier;
}

/** Messages a turn or runtime result adds to the conversation at commit. */
export function journalOf(carrier: object): readonly TurnMessageRecord[] {
  return (carrier as JournalCarrier)[EXECUTION_JOURNAL] ?? [];
}

/** Mark a result as one run of its runtime for the trigger ledger. */
export function attachRuntimeTrigger(result: object, runtimeId: string): void {
  Object.defineProperty(result, RUNTIME_TRIGGER, {
    value: runtimeId,
    enumerable: false,
    configurable: true,
  });
}

/** Runtime ids of every counted run in one execution, one entry per run. */
export function collectExecutionTriggers(
  turnResult: Pick<TurnResult, "runtimeResults" | "nestedRuntimeResults">,
): readonly string[] {
  const results = new Set<object>([
    ...turnResult.runtimeResults,
    ...(turnResult.nestedRuntimeResults ?? []),
  ]);
  return [...results].flatMap((result) => {
    const runtimeId = (result as JournalCarrier)[RUNTIME_TRIGGER];
    return runtimeId ? [runtimeId] : [];
  });
}

/** Collect and de-duplicate every pending message produced by one execution. */
export function collectExecutionJournal(
  turnResult: Pick<TurnResult, "runtimeResults" | "nestedRuntimeResults">,
): readonly TurnMessageRecord[] {
  const all = [
    ...journalOf(turnResult),
    ...turnResult.runtimeResults.flatMap((result) => journalOf(result)),
    ...(turnResult.nestedRuntimeResults ?? []).flatMap((result) =>
      journalOf(result),
    ),
  ];
  const seen = new Set<string>();
  return all.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

/**
 * Count a successful run and journal what it shows the player. Manual outputs
 * stay out of history (and uncounted) unless a committed interaction needs
 * validation. Only text (`narrativeOutput` / `content`) becomes message
 * content: structured outputs already live on the `turn_results` row, and
 * copying them here made every turn's JSON count toward compaction, feed the
 * summary model and enter recall. A run with no text, interaction or UI block
 * writes no row; the trigger ledger counts it. A concealed runtime's text is
 * never journaled: the conversation feeds other runtimes' prompts and the
 * message endpoints. What it shows on purpose (interactions, UI blocks) is.
 */
export function attachRuntimeJournal(
  result: RuntimeResult,
  input: TurnInput,
  manifest: RuntimeManifest,
  output: Readonly<Record<string, unknown>>,
): void {
  const interactions = Array.isArray(result.effects?.interactions)
    ? result.effects.interactions
    : undefined;
  if (
    result.status !== "success" ||
    (input.manualTrigger && !interactions?.length)
  )
    return;
  const content =
    input.manualTrigger || manifest.concealed
      ? ""
      : typeof output.narrativeOutput === "string"
        ? output.narrativeOutput
        : typeof output.content === "string"
          ? output.content
          : "";
  attachRuntimeTrigger(result, manifest.name);
  const ui = Array.isArray(result.effects?.ui) ? result.effects.ui : undefined;
  if (!content && !interactions?.length && !ui?.length) return;
  attachExecutionJournal(result, [
    {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceType: "runtime",
      sourcePluginId: manifest.pluginId,
      sourceRuntimeId: manifest.name,
      role: "assistant",
      name: manifest.name,
      content,
      order: stageMessageOrder(getRuntimeSpec(manifest).stage),
      pendingInput: interactions,
      ui,
      createdAt: new Date().toISOString(),
    },
  ]);
}
