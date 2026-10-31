import { z } from "zod";

export const DEFAULT_AUTO_ADVANCE_LIMIT = 3;
export const MAX_AUTO_ADVANCE_LIMIT = 10;

/** Additional foreground executions allowed after one submitted input. */
export const autoAdvanceLimitSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_AUTO_ADVANCE_LIMIT);

export function resolveAutoAdvanceLimit(value: unknown): number {
  return autoAdvanceLimitSchema.parse(
    value === undefined ? DEFAULT_AUTO_ADVANCE_LIMIT : value,
  );
}
