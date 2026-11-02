import { concealTracePayload } from "./concealed-runtime.js";

const TYPES = new Set([
  "step.started",
  "step.completed",
  "llm.calling",
  "tool.calling",
  "tool.completed",
  "tool.failed",
]);
const REJECTIONS = new Set([
  "invalid-json",
  "invalid-output",
  "missing-submission",
  "required-work",
  "review-rejected",
  "submission-batch",
  "superseded",
]);

export function isRuntimeProgressType(type: string): boolean {
  return TYPES.has(type);
}

/** Content-free projection shared by live action streams and replayable progress. */
export function runtimeProgressPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { concealed: _concealed, ...progress } = concealTracePayload(payload);
  if (Array.isArray(progress.notes))
    progress.notes = progress.notes.flatMap((note: unknown) => {
      if (!note || typeof note !== "object") return [];
      const value = note as Record<string, unknown>;
      return value.kind === "output-rejected" &&
        typeof value.reason === "string" &&
        REJECTIONS.has(value.reason) &&
        Number.isSafeInteger(value.attempt) &&
        Number(value.attempt) > 0
        ? [
            {
              kind: "output-rejected",
              reason: value.reason,
              attempt: value.attempt,
            },
          ]
        : [];
    });
  return {
    ...progress,
    ...(payload.concealed === true ? { concealed: true } : {}),
  };
}
