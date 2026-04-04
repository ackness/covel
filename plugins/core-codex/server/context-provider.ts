import type { ContextProviderInput } from "@covel/plugin-runtime";
import { getCodexSummary, EMPTY_STATE, type CodexState } from "./codex-logic.js";

/**
 * Context provider that injects discovered codex entries into the runtime context.
 * This allows the narrator and other runtimes to reference known knowledge.
 */
export async function codexContextProvider(
  input: ContextProviderInput,
): Promise<unknown> {
  const isZh = input.locale.startsWith("zh");
  const state = input.state as Record<string, unknown> | undefined;
  const codexState = (state?.["core-codex"] as CodexState) ?? EMPTY_STATE;

  const summary = getCodexSummary(codexState, input.locale);

  return {
    id: "codex-entries",
    title: isZh ? "已发现的图鉴条目" : "Discovered Codex Entries",
    content: summary,
    priority: 60,
  };
}
