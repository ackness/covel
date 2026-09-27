import type {
  RuntimeManifest,
  RuntimeResult,
  TurnDigest,
  TurnInput,
} from "@covel/shared";

/** Construct once at the source DAG boundary; detached workers reuse this value. */
export function buildTurnDigest(
  input: TurnInput,
  results: readonly RuntimeResult[],
  runtimes: readonly RuntimeManifest[],
): TurnDigest {
  const story = new Set(
    runtimes
      .filter((runtime) => runtime.outputKind === "story")
      .map((runtime) => runtime.name),
  );
  const successful = results.filter(
    (result) => result.status === "success" && result.turnId === input.turnId,
  );
  return Object.freeze({
    turnId: input.turnId,
    playerMessage: input.playerMessage,
    ...(input.locale ? { locale: input.locale } : {}),
    narrativeText: successful
      .filter((result) => story.has(result.runtimeId))
      .flatMap((result) => {
        const text =
          result.output?.narrativeOutput ??
          result.output?.text ??
          result.output?.content;
        return typeof text === "string" && text.trim() ? [text] : [];
      })
      .join("\n\n"),
    toolCallSummaries: Object.freeze(
      successful.flatMap((result) =>
        (result.toolCalls ?? [])
          .filter(
            (call) =>
              call.approvalStatus === "auto-allowed" &&
              !(
                call.output &&
                typeof call.output === "object" &&
                "error" in call.output
              ),
          )
          .map(
            (call) =>
              `[${call.toolName}] ${JSON.stringify(call.input).slice(0, 200)}`,
          ),
      ),
    ),
  });
}
