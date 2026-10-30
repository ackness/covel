import { z } from "zod";

const identitySchema = z
  .object({
    runtimeId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
  })
  .passthrough();

function readStep(step: unknown): z.infer<typeof identitySchema> {
  const parsed = identitySchema.safeParse(step);
  if (!parsed.success) throw new Error("Invalid execution history identity");
  return parsed.data;
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
  const rows: Array<z.infer<typeof identitySchema>> = [];
  for (const raw of [...current, ...incoming]) {
    const step = readStep(raw);
    let match = -1;
    let newestTime = Number.NEGATIVE_INFINITY;
    for (const [index, row] of rows.entries()) {
      if (row.turnId !== step.turnId || row.runtimeId !== step.runtimeId)
        continue;
      if (step.runId && row.runId === step.runId) {
        match = index;
        break;
      }
      if (step.runId && row.runId) continue;
      const startedAt = row.startedAt ?? row.turnStartedAt;
      const parsed =
        typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
      const time = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
      if (time >= newestTime) {
        match = index;
        newestTime = time;
      }
    }
    const previous = rows[match];
    // Anonymous observations update the newest run; an identified run may
    // adopt only an anonymous placeholder, never a different identified run.
    const updated =
      previous?.runId && !step.runId
        ? { ...step, runId: previous.runId }
        : step;
    if (match < 0) rows.push(updated);
    else rows[match] = updated;
  }
  return rows.slice(-EXECUTION_HISTORY_MAX_ROWS);
}
