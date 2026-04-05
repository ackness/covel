import type { ContextProviderInput } from "@covel/plugin-runtime";
import { getEventSummary, EMPTY_STATE, type EventState } from "./event-logic.js";

/**
 * Context provider that injects active event information into the runtime context.
 * This allows the narrator and other runtimes to reference current event timeline.
 */
export async function eventContextProvider(
  input: ContextProviderInput,
): Promise<unknown> {
  const isZh = input.locale.startsWith("zh");
  const state = input.state as Record<string, unknown> | undefined;
  const eventState = (state?.["core-event"] as EventState) ?? EMPTY_STATE;
  const events = eventState.events;

  const summary = getEventSummary(eventState, input.locale);

  return {
    id: "event-timeline",
    title: isZh ? "当前事件时间线" : "Current Event Timeline",
    content: summary,
    priority: 65,
  };
}
