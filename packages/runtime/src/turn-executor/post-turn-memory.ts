import type { TurnInput, TurnResult } from "@covel/shared";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
import type { CoreMemoryBlock } from "./session-state.js";

export function schedulePostTurnMemoryUpdate(args: {
  readonly input: TurnInput;
  readonly turnResult: TurnResult;
  readonly deps: TurnExecutorDeps;
  readonly coreMemoryBlocks: readonly CoreMemoryBlock[];
}): void {
  const { input, turnResult, deps, coreMemoryBlocks } = args;
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

  deps.memorySystem.updater
    .updateAfterTurn({
      sessionId: input.sessionId,
      narrativeText,
      toolCallSummaries: toolSummaries.length > 0 ? toolSummaries : undefined,
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
        err instanceof Error ? err.message : String(err),
      );
    });
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
