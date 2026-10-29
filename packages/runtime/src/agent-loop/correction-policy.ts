import type { LoopPresetValues } from "@covel/shared";

export type CorrectionBudgets = LoopPresetValues["corrections"];
export type CorrectionKind = keyof CorrectionBudgets;

export interface CorrectionPolicy {
  take(kind: CorrectionKind): boolean;
  used(kind: CorrectionKind): number;
  snapshot(): Readonly<Record<CorrectionKind, number>>;
}

/** One independent, bounded correction budget per kind, for one loop run. */
export function createCorrectionPolicy(
  budgets: CorrectionBudgets,
): CorrectionPolicy {
  const limits = { ...budgets };
  const counts: Record<CorrectionKind, number> = {
    toolUse: 0,
    review: 0,
    loopPerturbation: 0,
    outputRepair: 0,
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
