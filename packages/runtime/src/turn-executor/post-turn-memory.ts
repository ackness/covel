import type { SessionContextSnapshot } from "@covel/context";
import {
  resolveI18nText,
  type I18nText,
  type TurnInput,
  type TurnResult,
} from "@covel/shared";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
import type { CoreMemoryBlock } from "./session-state.js";

export function schedulePostTurnMemoryUpdate(args: {
  readonly input: TurnInput;
  readonly turnResult: TurnResult;
  readonly deps: TurnExecutorDeps;
  readonly coreMemoryBlocks: readonly CoreMemoryBlock[];
  readonly sessionContext?: SessionContextSnapshot;
}): void {
  const { input, turnResult, deps, coreMemoryBlocks, sessionContext } = args;
  if (!deps.memorySystem || coreMemoryBlocks.length === 0) {
    return;
  }

  const narrativeParts = collectNarrativeParts(turnResult);
  const narrativeText = narrativeParts.join("\n\n");

  if (!narrativeText.trim()) {
    return;
  }

  const toolSummaries = turnResult.runtimeResults.flatMap((rr) =>
    rr.toolCalls.map(
      (tc) => `[${tc.toolName}] ${JSON.stringify(tc.input).slice(0, 200)}`,
    ),
  );
  const playerCharacter = sessionContext?.characters.find(
    (character) => character.type === "player",
  );
  const lastFormValues = sessionContext?.sessionMeta.lastFormValues;
  const playerFieldLabels = extractPlayerFieldLabels(
    sessionContext?.world.schema,
    input.locale,
  );
  const authoritativeFacts =
    playerCharacter || lastFormValues
      ? {
          ...(playerCharacter ? { playerCharacter } : {}),
          ...(playerFieldLabels ? { playerFieldLabels } : {}),
          ...(lastFormValues ? { lastFormValues } : {}),
        }
      : undefined;

  deps.memorySystem.updater
    .updateAfterTurn({
      sessionId: input.sessionId,
      narrativeText,
      toolCallSummaries: toolSummaries.length > 0 ? toolSummaries : undefined,
      authoritativeFacts,
      currentBlocks: coreMemoryBlocks,
      locale: input.locale,
    })
    .then((result) => {
      if (result.error) {
        console.warn(
          `[turn-executor] memory update for ${input.sessionId} reported error: ${result.error}`,
        );
      }
    })
    .catch((err) => {
      console.warn(
        `[turn-executor] memory update failed for ${input.sessionId}:`,
        err,
      );
    });
}

function extractPlayerFieldLabels(
  worldSchema: Readonly<Record<string, unknown>> | undefined,
  locale: string | undefined,
): Readonly<Record<string, string>> | undefined {
  const characterSchema = worldSchema?.["character-attributes"];
  if (!characterSchema || typeof characterSchema !== "object") return undefined;

  const attributes = (characterSchema as Record<string, unknown>).attributes;
  if (!Array.isArray(attributes)) return undefined;

  const labels: Record<string, string> = {};
  for (const attribute of attributes) {
    if (!attribute || typeof attribute !== "object") continue;
    const { id, name } = attribute as Record<string, unknown>;
    if (typeof id !== "string" || !id.trim()) continue;
    if (typeof name === "string") {
      labels[id] = name;
      continue;
    }
    if (name && typeof name === "object" && !Array.isArray(name)) {
      const resolved = resolveI18nText(name as I18nText, locale);
      if (resolved) labels[id] = resolved;
    }
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

function collectNarrativeParts(turnResult: TurnResult): string[] {
  const narrativeParts: string[] = [];
  for (const rr of turnResult.runtimeResults) {
    const out = rr.output as Record<string, unknown> | null;
    const text =
      (out?.narrativeOutput as string) ?? (out?.text as string) ?? "";
    if (text.trim()) narrativeParts.push(text);
  }
  return narrativeParts;
}
