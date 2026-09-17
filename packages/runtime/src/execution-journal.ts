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

type JournalCarrier = object & {
  readonly [EXECUTION_JOURNAL]?: readonly TurnMessageRecord[];
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

function journalOf(carrier: object): readonly TurnMessageRecord[] {
  return (carrier as JournalCarrier)[EXECUTION_JOURNAL] ?? [];
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

/** Manual outputs stay out of history unless a committed interaction needs validation. */
export function attachRuntimeJournal(
  result: RuntimeResult,
  input: TurnInput,
  manifest: RuntimeManifest,
  output: Readonly<Record<string, unknown>>,
): void {
  const interactions = Array.isArray(output.interactions)
    ? output.interactions
    : undefined;
  if (
    result.status !== "success" ||
    (input.manualTrigger && !interactions?.length)
  )
    return;
  const content = input.manualTrigger
    ? ""
    : typeof output.narrativeOutput === "string"
      ? output.narrativeOutput
      : typeof output.content === "string"
        ? output.content
        : JSON.stringify(output);
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
      ui: Array.isArray(output.ui) ? output.ui : undefined,
      createdAt: new Date().toISOString(),
    },
  ]);
}
