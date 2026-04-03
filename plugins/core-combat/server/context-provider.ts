import { resolve } from "node:path";
import type { ContextProviderInput } from "@covel/plugin-runtime";
import { loadPrompt } from "@covel/context";
import { getCombatSummary } from "./combat-logic.js";
import type { CombatState } from "./combat-logic.js";

const PROMPTS_DIR = resolve(import.meta.dirname, "../prompts");

/**
 * Combat context provider.
 * When combat is active, injects combat status (participants, HP, turn order, current actor)
 * as high-priority context so the LLM is fully aware of the combat situation.
 */
export async function combatContextProvider(
  input: ContextProviderInput
): Promise<{
  id: string;
  title: string;
  content: string;
  priority: number;
} | null> {
  const state = input.state as Record<string, unknown> | undefined;

  if (!state || !state.combat || typeof state.combat !== "object") {
    return null;
  }

  const raw = state.combat as Record<string, unknown>;
  if (
    typeof raw.active !== "boolean" ||
    !Array.isArray(raw.turnOrder) ||
    typeof raw.roundNumber !== "number"
  ) {
    return null;
  }

  const combat = raw as unknown as CombatState;

  if (!combat.active) {
    return null;
  }

  const isZh = input.locale.startsWith("zh");
  const summary = getCombatSummary(combat, input.locale);

  const rules = await loadPrompt(PROMPTS_DIR, "combat-rules", input.locale);
  const statusTitle = isZh ? "## 战斗状态" : "## Combat Status";
  const instructions = [statusTitle, "", summary, "", rules].join("\n");

  return {
    id: "combat-status",
    title: isZh ? "战斗状态" : "Combat Status",
    content: instructions,
    priority: 90,
  };
}
