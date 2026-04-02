import type { ContextProviderInput } from "@covel/plugin-runtime";
import { getCombatSummary } from "./combat-logic.js";
import type { CombatState } from "./combat-logic.js";

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

  const combat = state.combat as CombatState;

  if (!combat.active) {
    return null;
  }

  const isZh = input.locale.startsWith("zh");
  const summary = getCombatSummary(combat, input.locale);

  const instructions = isZh
    ? [
        "## 战斗状态",
        "",
        summary,
        "",
        "### 战斗规则",
        "- 你正在管理一场回合制战斗。",
        "- 按照先攻顺序处理每个参与者的行动。",
        "- 玩家行动：使用 `attack`、`defend` 或 `use-skill` 工具。",
        "- 敌人行动：根据战术情境决定并调用相应工具。",
        "- 每次攻击或技能必须先通过 `core-dice:roll-check` 投骰。",
        "- 生动地叙述每个行动的结果。",
      ].join("\n")
    : [
        "## Combat Status",
        "",
        summary,
        "",
        "### Combat Rules",
        "- You are managing a turn-based combat encounter.",
        "- Process each participant's action in initiative order.",
        "- Player actions: use `attack`, `defend`, or `use-skill` tools.",
        "- Enemy actions: decide based on tactical context and call the appropriate tool.",
        "- Every attack or skill must be preceded by a `core-dice:roll-check` dice roll.",
        "- Narrate each action's outcome vividly.",
      ].join("\n");

  return {
    id: "combat-status",
    title: isZh ? "战斗状态" : "Combat Status",
    content: instructions,
    priority: 90,
  };
}
