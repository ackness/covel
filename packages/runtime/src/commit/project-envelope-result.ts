/**
 * envelope-v1 → legacy output projection (compat-era; removed in Step 6).
 *
 * The kernel's result consumers — commit `normalizeOutput`, the turn-message
 * narrative, pre-game completion (`output.preGameDone`), input-binding
 * `select`, plugin-rpc — all read business / domain / completion fields from
 * the TOP LEVEL of `RuntimeResult.output`. An envelope-v1 handler returns them
 * nested under `value` / `effects` / `completion`, so a SUCCESS envelope is
 * flattened back to the legacy top-level shape at the single point where
 * `RuntimeResult.output` is built (turn-function-runtime). Every consumer stays
 * unchanged and envelope-v1 becomes a pure author-side return format.
 *
 * Only success is projected: a non-success outcome stores its raw return (the
 * "non-success carries no domain writes" rule already stripped effects in
 * normalize). Legacy handlers never reach here.
 */

import type { HandlerResult } from "@covel/shared";
import { getPendingProposals, withPendingProposals } from "@covel/tools";
import {
  DOMAIN_EFFECT_KEYS,
  isPlainObject,
} from "./normalize-handler-result.js";

type SuccessOutcome = Extract<HandlerResult, { outcome: "success" }>;

/**
 * Flatten a normalized success envelope into the legacy top-level output the
 * kernel consumers read, carrying the raw return's pending-proposals Symbol
 * onto the fresh object.
 */
export function projectEnvelopeSuccessToLegacyOutput(
  outcome: SuccessOutcome,
  rawOutput: unknown,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};

  // 1. value: a plain object flattens to the top level; a scalar/array keeps
  //    its `value` key so a reader can still find it.
  if (outcome.value !== undefined) {
    if (isPlainObject(outcome.value)) {
      Object.assign(projected, outcome.value);
    } else {
      projected.value = outcome.value;
    }
  }

  // 2. effects domain keys hoist to the top level (obs channels — jobStatus /
  //    diagnostics — stay out; the consumers don't read them). effects wins a
  //    key clash with value.
  const effects = outcome.effects as Record<string, unknown> | undefined;
  if (effects) {
    for (const key of DOMAIN_EFFECT_KEYS) {
      const value = effects[key];
      if (value === undefined || value === null) continue;
      if (key in projected) {
        console.warn(
          `[runtime] envelope projection: effects.${key} overrides value.${key}`,
        );
      }
      projected[key] = value;
    }
  }

  // 3. completion:"done" is the legacy pre-game completion signal.
  if (outcome.completion === "done") {
    projected.preGameDone = true;
  }

  // 4. Carry the handler's pending-proposals Symbol onto the new object — a
  //    fresh object drops the non-enumerable Symbol, so re-attach it.
  const pending = getPendingProposals(rawOutput);
  return pending.length > 0
    ? (withPendingProposals(projected, pending) as Record<string, unknown>)
    : projected;
}
