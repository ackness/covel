import type { ExecutionStep, ReasoningEntry, SessionAction } from "./types.js";

export function mergeReasoning(
  previous: readonly ReasoningEntry[] = [],
  incoming: readonly ReasoningEntry[] = [],
): ReasoningEntry[] {
  return [
    ...new Map(
      [...previous, ...incoming].map((entry) => [entry.id, entry]),
    ).values(),
  ].sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      (a.sequence ?? 0) - (b.sequence ?? 0),
  );
}

/** Shared by live action events and persisted trace recovery. */
export function reasoningAction(
  type: string,
  payload: Readonly<Record<string, unknown>>,
  turnId: string | undefined,
  timestamp: string,
): Extract<SessionAction, { type: "APPEND_REASONING" }> | undefined {
  if (type !== "llm.responded" && type !== "gateway.responded")
    return undefined;
  const { runtimeId, reasoningContent, flowId, seq } = payload;
  if (
    !turnId ||
    typeof runtimeId !== "string" ||
    !runtimeId ||
    typeof reasoningContent !== "string" ||
    !reasoningContent.trim()
  )
    return undefined;
  const sequence =
    typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
  return {
    type: "APPEND_REASONING",
    turnId,
    runtimeId,
    pluginId: typeof payload.pluginId === "string" ? payload.pluginId : "",
    entry: {
      id: JSON.stringify([
        turnId,
        runtimeId,
        type,
        flowId ?? "",
        sequence ?? timestamp,
        payload.attempt ?? "",
      ]),
      content: reasoningContent,
      timestamp,
      ...(sequence !== undefined ? { sequence } : {}),
      ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    },
  };
}

export function appendReasoningStep(
  previous: ExecutionStep | undefined,
  action: Extract<SessionAction, { type: "APPEND_REASONING" }>,
): ExecutionStep {
  return {
    runtimeId: action.runtimeId,
    pluginId: action.pluginId,
    turnId: action.turnId,
    status: "llm",
    ...previous,
    reasoning: mergeReasoning(previous?.reasoning, [action.entry]),
  };
}
