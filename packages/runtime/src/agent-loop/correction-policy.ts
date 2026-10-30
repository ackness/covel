import type { LoopPresetValues } from "@covel/shared";

export type CorrectionBudgets = LoopPresetValues["corrections"];
export type CorrectionKind = keyof CorrectionBudgets;

export interface CorrectionPolicy {
  take(kind: CorrectionKind): boolean;
  used(kind: CorrectionKind): number;
  snapshot(): Readonly<Record<CorrectionKind, number>>;
}

/**
 * One independent, bounded correction budget per kind, for one logical
 * runtime. `used` seeds the counts a resumed loop already spent before its
 * suspension; `take` compares them with the budget in force now.
 */
export function createCorrectionPolicy(
  budgets: CorrectionBudgets,
  used?: Readonly<Partial<Record<CorrectionKind, number>>>,
): CorrectionPolicy {
  const limits = { ...budgets };
  const counts: Record<CorrectionKind, number> = {
    toolUse: used?.toolUse ?? 0,
    review: used?.review ?? 0,
    loopPerturbation: used?.loopPerturbation ?? 0,
    outputRepair: used?.outputRepair ?? 0,
  };
  return {
    take(kind) {
      if (counts[kind] >= limits[kind]) return false;
      counts[kind]++;
      return true;
    },
    used: (kind) => counts[kind],
    snapshot: () => Object.freeze({ ...counts }),
  };
}
