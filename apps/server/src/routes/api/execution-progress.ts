import { concealTracePayload } from "@covel/shared";

/** Gameplay streams carry progress; full computation content stays in traces. */
export function executionProgressPayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (type === "message.completed") return undefined;
  if (
    !type.startsWith("llm.") &&
    !type.startsWith("tool.") &&
    !type.startsWith("hook.") &&
    !type.startsWith("recursive.") &&
    !type.startsWith("subagent.") &&
    !type.startsWith("function.") &&
    !type.startsWith("gateway.")
  )
    return payload;
  const { concealed: _concealed, ...progress } = concealTracePayload(payload);
  return {
    ...progress,
    ...(payload.concealed === true ? { concealed: true } : {}),
  };
}
