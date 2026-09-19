import { z } from "zod";

const identitySchema = z.object({
  runtimeId: z.string().min(1),
  turnId: z.string().min(1).optional(),
});

function stepKey(step: unknown): string {
  const parsed = identitySchema.safeParse(step);
  if (!parsed.success) throw new Error("Invalid execution history identity");
  return JSON.stringify([parsed.data.turnId ?? null, parsed.data.runtimeId]);
}

/**
 * Each browser can hold only part of the history. Missing rows are not deletions.
 * Matching rows use the incoming observation; status alone cannot order a
 * suspended runtime's resumption. Callers serialize this merge with the write.
 */
export function mergeExecutionHistory(
  current: readonly unknown[],
  incoming: readonly unknown[],
): unknown[] {
  const rows = new Map(current.map((step) => [stepKey(step), step]));
  for (const step of incoming) rows.set(stepKey(step), step);
  return [...rows.values()];
}
