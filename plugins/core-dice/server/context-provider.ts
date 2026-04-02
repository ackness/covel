import type { ContextProviderInput } from "@covel/plugin-runtime";

interface LastRollResult {
  readonly skill?: string | null;
  readonly system?: string;
  readonly outcome?: string;
  readonly roll?: { readonly total: number; readonly rolls: readonly number[] };
  readonly dc?: number;
  readonly total?: number;
  readonly margin?: number;
  readonly successRate?: number;
  readonly rolled?: number;
}

interface DiceState {
  readonly lastRollResult?: LastRollResult;
}

/**
 * Format a check outcome for narrative context injection.
 */
function formatOutcome(outcome: string, locale: string): string {
  const isZh = locale.startsWith("zh");
  const labels: Record<string, { zh: string; en: string }> = {
    critical_success: { zh: "大成功", en: "Critical Success" },
    success: { zh: "成功", en: "Success" },
    failure: { zh: "失败", en: "Failure" },
    critical_failure: { zh: "大失败", en: "Critical Failure" },
  };
  const label = labels[outcome];
  return label ? (isZh ? label.zh : label.en) : outcome;
}

/**
 * Format a d20/custom check result into a readable string.
 */
function formatCheckResult(
  result: LastRollResult,
  locale: string
): string {
  const isZh = locale.startsWith("zh");
  const skill = result.skill ?? (isZh ? "通用" : "General");
  const outcome = formatOutcome(result.outcome ?? "unknown", locale);
  const rollTotal = result.roll?.total ?? result.total ?? 0;
  const dc = result.dc ?? 0;
  const margin = result.margin ?? 0;
  const marginSign = margin >= 0 ? "+" : "";

  if (isZh) {
    return `- 技能: ${skill}, 结果: ${outcome} (掷出 ${rollTotal} vs DC ${dc}, 差值 ${marginSign}${margin})`;
  }
  return `- Skill: ${skill}, Result: ${outcome} (rolled ${rollTotal} vs DC ${dc}, margin ${marginSign}${margin})`;
}

/**
 * Format a percentage check result into a readable string.
 */
function formatPercentageResult(
  result: LastRollResult,
  locale: string
): string {
  const isZh = locale.startsWith("zh");
  const skill = result.skill ?? (isZh ? "通用" : "General");
  const outcome = formatOutcome(result.outcome ?? "unknown", locale);
  const rolled = result.rolled ?? 0;
  const successRate = result.successRate ?? 0;

  if (isZh) {
    return `- 技能: ${skill}, 结果: ${outcome} (掷出 ${rolled}, 成功率 ${successRate}%)`;
  }
  return `- Skill: ${skill}, Result: ${outcome} (rolled ${rolled}, success rate ${successRate}%)`;
}

/**
 * Context provider that reads the last dice roll result from state
 * and formats it for injection into the narrator's context.
 */
export async function diceContextProvider(
  ctx: ContextProviderInput
): Promise<unknown> {
  const state = ctx.state as DiceState | undefined;
  const lastRoll = state?.lastRollResult;

  if (!lastRoll) {
    return null;
  }

  const locale = ctx.locale ?? "zh-CN";
  const isZh = locale.startsWith("zh");

  const header = isZh ? "## 最近判定结果" : "## Recent Check Result";

  const formatted =
    lastRoll.system === "percentage"
      ? formatPercentageResult(lastRoll, locale)
      : formatCheckResult(lastRoll, locale);

  return `${header}\n${formatted}`;
}
