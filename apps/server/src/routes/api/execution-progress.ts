import {
  concealTracePayload,
  isRuntimeProgressType,
  runtimeProgressPayload,
  type SubscriptionEvent,
  type SubscriptionTopic,
} from "@covel/shared";

/** Diagnostic readers keep raw traces; gameplay consumes the public copy once. */
export function selectSubscriptionProgress(
  event: SubscriptionEvent,
  topics: ReadonlySet<SubscriptionTopic> | null,
): SubscriptionEvent | undefined {
  if (
    event.topic === "trace" &&
    !topics?.has("trace") &&
    isRuntimeProgressType(event.type)
  )
    return;
  return !topics || topics.has(event.topic) ? event : undefined;
}

/** Gameplay streams carry progress; full computation content stays in traces. */
export function executionProgressPayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (type === "message.completed") return undefined;
  if (isRuntimeProgressType(type)) return runtimeProgressPayload(payload);
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
