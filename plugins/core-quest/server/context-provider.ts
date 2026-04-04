import type { ContextProviderInput } from "@covel/plugin-runtime";
import { getQuestSummary, EMPTY_STATE, type QuestState } from "./quest-logic.js";

/**
 * Context provider that injects active quest information into the runtime context.
 * This allows the narrator and other runtimes to reference current quest status.
 */
export async function questContextProvider(
  input: ContextProviderInput,
): Promise<unknown> {
  const isZh = input.locale.startsWith("zh");
  const state = input.state as Record<string, unknown> | undefined;
  const questState = (state?.["core-quest"] as QuestState) ?? EMPTY_STATE;
  const quests = questState.quests;

  if (!quests || quests.length === 0) return null;

  const summary = getQuestSummary(questState, input.locale);

  return {
    id: "quest-status",
    title: isZh ? "当前任务状态" : "Current Quest Status",
    content: summary,
    priority: 70,
  };
}
