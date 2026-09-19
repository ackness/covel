import type { SessionContextSnapshot } from "@covel/context";
import {
  resolveI18nText,
  type I18nText,
  type RuntimeManifest,
  type TurnInput,
  type TurnResult,
} from "@covel/shared";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
import type { CoreMemoryBlock } from "./session-state.js";

export function buildPostTurnMemoryUpdate(args: {
  readonly input: Pick<TurnInput, "sessionId" | "turnId" | "locale">;
  readonly turnResult: Pick<TurnResult, "runtimeResults">;
  readonly runtimes: readonly Pick<RuntimeManifest, "name" | "outputKind">[];
  readonly deps: Pick<TurnExecutorDeps, "memorySystem" | "emitter">;
  readonly coreMemoryBlocks: readonly CoreMemoryBlock[];
  readonly sessionContext?: SessionContextSnapshot;
}):
  | Parameters<
      NonNullable<
        TurnExecutorDeps["memorySystem"]
      >["updater"]["updateAfterTurn"]
    >[0]
  | undefined {
  const { input, turnResult, deps, coreMemoryBlocks, sessionContext } = args;
  if (!deps.memorySystem || coreMemoryBlocks.length === 0) {
    return;
  }

  const storyRuntimeIds = new Set(
    args.runtimes
      .filter((runtime) => runtime.outputKind === "story")
      .map((runtime) => runtime.name),
  );
  const narrativeParts = collectNarrativeParts(
    turnResult,
    input.turnId,
    storyRuntimeIds,
  );
  const narrativeText = narrativeParts.join("\n\n");

  if (!narrativeText.trim()) {
    return;
  }

  const toolSummaries = turnResult.runtimeResults
    .filter((rr) => rr.status === "success" && rr.turnId === input.turnId)
    .flatMap((rr) =>
      rr.toolCalls
        .filter(
          (tc) =>
            tc.approvalStatus === "auto-allowed" &&
            !(
              tc.output &&
              typeof tc.output === "object" &&
              "error" in tc.output
            ),
        )
        .map(
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

  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    traceId: deps.emitter?.traceId,
    narrativeText,
    toolCallSummaries: toolSummaries.length > 0 ? toolSummaries : undefined,
    authoritativeFacts,
    currentBlocks: coreMemoryBlocks,
    locale: input.locale,
  };
}

export function dispatchMemoryUpdate(
  memory: NonNullable<TurnExecutorDeps["memorySystem"]>,
  input: Parameters<typeof memory.updater.updateAfterTurn>[0],
): void {
  void memory.updater
    .updateAfterTurn(input)
    .then((result) => {
      if (result.error)
        console.warn(
          `[turn-executor] memory update for ${input.sessionId} reported error: ${result.error}`,
        );
    })
    .catch((error: unknown) =>
      console.warn(
        `[turn-executor] memory update failed for ${input.sessionId}:`,
        error,
      ),
    );
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

function collectNarrativeParts(
  turnResult: Pick<TurnResult, "runtimeResults">,
  turnId: string,
  storyRuntimeIds: ReadonlySet<string>,
): string[] {
  const narrativeParts: string[] = [];
  for (const rr of turnResult.runtimeResults) {
    // Retry seed results are context, not newly committed narrative.
    if (
      rr.status !== "success" ||
      rr.turnId !== turnId ||
      !storyRuntimeIds.has(rr.runtimeId)
    )
      continue;
    const out = rr.output as Record<string, unknown> | null;
    const text = out?.narrativeOutput ?? out?.text;
    if (typeof text === "string" && text.trim()) narrativeParts.push(text);
  }
  return narrativeParts;
}
