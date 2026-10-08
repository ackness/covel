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
 * Rows this cache keeps for one session: twice the 500 a session writes at a
 * time, so the windows of two tabs both fit. Every save rewrites the record.
 */
export const EXECUTION_HISTORY_MAX_ROWS = 1000;

/**
 * Each browser can hold only part of the history. Missing rows are not deletions.
 * Matching rows use the incoming observation; status alone cannot order a
 * suspended runtime's resumption. Callers serialize this merge with the write.
 * The oldest rows, by when this cache first saw them, leave past the limit.
 */
export function mergeExecutionHistory(
  current: readonly unknown[],
  incoming: readonly unknown[],
): unknown[] {
  const rows = new Map(current.map((step) => [stepKey(step), step]));
  for (const step of incoming) rows.set(stepKey(step), step);
  return [...rows.values()].slice(-EXECUTION_HISTORY_MAX_ROWS);
}
