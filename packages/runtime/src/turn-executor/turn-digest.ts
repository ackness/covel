import { playerInputSubmissionSchema, turnDigestSchema } from "@covel/shared";
import type {
  PlayerInputSubmission,
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
  lastPlayerInput: PlayerInputSubmission | null = null,
): TurnDigest {
  const story = new Set(
    runtimes
      .filter((runtime) => runtime.outputKind === "story")
      .map((runtime) => runtime.name),
  );
  const successful = results.filter(
    (result) => result.status === "success" && result.turnId === input.turnId,
  );
  return freezeSnapshot(
    turnDigestSchema.parse({
      turnId: input.turnId,
      playerMessage: input.playerMessage,
      lastPlayerInput: snapshotPlayerInput(lastPlayerInput),
      runtimeResults: results
        .filter(
          (result) =>
            result.turnId === input.turnId &&
            result.status !== "pending" &&
            result.status !== "running",
        )
        .map(({ runtimeId, status }) => ({ runtimeId, status })),
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
    }),
  );
}

/** Clone before freezing so handler code cannot mutate another runtime's view. */
export function snapshotPlayerInput(
  value: unknown,
): PlayerInputSubmission | null {
  return value === null
    ? null
    : freezeSnapshot(playerInputSubmissionSchema.parse(structuredClone(value)));
}

export function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
