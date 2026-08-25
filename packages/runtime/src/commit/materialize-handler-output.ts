/** Materialize a successful plugin HandlerResult into the kernel output. */

import type { HandlerResult } from "@covel/shared";
import { getPendingProposals, withPendingProposals } from "@covel/tools";
import {
  DOMAIN_EFFECT_KEYS,
  isPlainObject,
} from "./normalize-handler-result.js";

type SuccessOutcome = Extract<HandlerResult, { outcome: "success" }>;

/**
 * Flatten a normalized success result into the kernel's internal output,
 * carrying the raw return's pending-proposals Symbol onto the fresh object.
 */
export function materializeHandlerSuccess(
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
        console.warn(`[runtime] handler effects.${key} overrides value.${key}`);
      }
      projected[key] = value;
    }
  }

  // 3. The internal runtime output keeps the setup completion marker consumed
  // by scheduling and turn finalization.
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
