/** Materialize a successful plugin HandlerResult into the kernel output. */

import type { HandlerResult, RuntimeResult } from "@covel/shared";
import { getPendingProposals } from "@covel/tools";
import { isPlainObject } from "./normalize-handler-result.js";

type SuccessOutcome = Extract<HandlerResult, { outcome: "success" }>;

/**
 * Project the business value without mixing in effects or completion. Preserve
 * proposal-backed commands separately from the serializable business fields.
 */
export function materializeHandlerSuccess(
  outcome: SuccessOutcome,
  rawOutput: unknown,
): Pick<
  RuntimeResult,
  "output" | "effects" | "completion" | "pendingProposals"
> {
  const value = structuredClone(outcome.value);
  const projected: Record<string, unknown> = isPlainObject(value)
    ? { ...value }
    : value === undefined
      ? {}
      : { value };
  const pending = getPendingProposals(rawOutput);
  return {
    output: projected,
    ...(pending.length > 0 ? { pendingProposals: pending } : {}),
    ...(outcome.effects ? { effects: structuredClone(outcome.effects) } : {}),
    ...(outcome.completion ? { completion: outcome.completion } : {}),
  };
}
