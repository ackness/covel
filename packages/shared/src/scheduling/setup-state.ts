/**
 * Setup-runtime state machine — pure transitions (no store).
 *
 * The runtime-scheduling redesign gives each setup-band runtime a persistent
 * `SetupRuntimeState` (pending / done / blocked) mirrored onto the session row.
 * This module owns the pure derivations shared by the kernel (which resolves
 * pending/blocked from the attempt ledger during finalize) and the retry/waive
 * control API (which flips blocked → pending / done under player control).
 *
 * The deliberate change from the old model: exhausting a setup runtime's retry
 * budget no longer marks it "done" (the old "band-exhausted ⇒ advance anyway").
 * It becomes `blocked`, which holds the session in the setup band until the
 * player retries or waives it — no more limping past a broken initialisation.
 */

import type { RuntimeManifest } from "../types/plugin.js";
import { getRuntimeSpec } from "./normalize.js";
import type {
  SetupAttemptState,
  SetupRuntimeState,
} from "../types/runtime-lifecycle.js";

/** A runtime is a setup runtime iff its normalized stage is `setup`. */
export function isSetupRuntime(manifest: RuntimeManifest): boolean {
  return getRuntimeSpec(manifest).stage === "setup";
}

/**
 * A runtime belongs to the main loop iff it has a stage other than `setup`
 * (pre-turn / narrative / post-turn / audit). Stage-less runtimes (event /
 * manual / UI-only) are neither setup nor main-loop — they are never
 * band-scheduled. Replaces the old `isMainLoopPriority` (priority 100–1000).
 */
export function isMainLoopRuntime(manifest: RuntimeManifest): boolean {
  const stage = getRuntimeSpec(manifest).stage;
  return stage !== undefined && stage !== "setup";
}

/**
 * Retry budget for a setup runtime = its `maxTriggerCount` (undefined ⇒
 * unbounded, never blocks). Read from the normalized trigger so the legacy
 * `scheduled interval:1 maxTriggerCount:1` idiom (folded to `auto`) resolves
 * identically to a directly-declared `auto maxTriggerCount:1`.
 */
export function setupRetryBudget(
  manifest: RuntimeManifest,
): number | undefined {
  return getRuntimeSpec(manifest).declaredTrigger.maxTriggerCount;
}

/**
 * A ledger attempt counts toward the retry budget iff it reached a terminal,
 * non-suspended state. `suspended` is a pause, not a spent attempt (a resumed
 * suspension reuses the same attempt id — resume lands in a later wave).
 */
export function isBudgetedAttempt(state: SetupAttemptState): boolean {
  return state === "success" || state === "failed" || state === "skipped";
}

/**
 * Resolve the mirror for a setup runtime that ran but did NOT complete: blocked
 * once the terminal attempt count reaches the budget, pending otherwise.
 */
export function resolvePendingOrBlocked(args: {
  readonly attempts: number;
  readonly budget: number | undefined;
  readonly pluginVersion: string;
  readonly generation: number;
  readonly now: string;
  readonly lastError?: string;
}): SetupRuntimeState {
  const { attempts, budget, pluginVersion, generation, now, lastError } = args;
  if (budget !== undefined && attempts >= budget) {
    return {
      state: "blocked",
      pluginVersion,
      generation,
      attempts,
      reason: `setup exhausted its retry budget (${attempts}/${budget} attempts, never completed)`,
      blockedAt: now,
    };
  }
  return {
    state: "pending",
    pluginVersion,
    generation,
    attempts,
    ...(lastError ? { lastError } : {}),
  };
}

/** Whether a setup runtime's persisted mirror counts as satisfied (done, incl. waived). */
export function isSetupSatisfied(
  state: SetupRuntimeState | undefined,
): boolean {
  return state?.state === "done";
}

/**
 * Whether a `done` mirror still satisfies the current plugin version. A version
 * change (re-enable / upgrade) invalidates the prior generation's `done` — the
 * setup must re-run against the new version.
 */
export function isSetupDoneForVersion(
  state: SetupRuntimeState | undefined,
  manifestVersion: string | undefined,
): boolean {
  return (
    state?.state === "done" &&
    state.pluginVersion === (manifestVersion ?? "0.0.0")
  );
}

/**
 * Effective generation for a setup runtime's next attempt. Reuses the prior
 * generation when the plugin version is unchanged; a version change starts a
 * fresh generation (prior + 1) so the new version's attempts never reuse the
 * old generation's `done` or spent budget.
 */
export function resolveSetupGeneration(
  manifestVersion: string | undefined,
  prior: SetupRuntimeState | undefined,
): number {
  if (!prior) return 1;
  return prior.pluginVersion === (manifestVersion ?? "0.0.0")
    ? prior.generation
    : prior.generation + 1;
}

export type SetupControlResult =
  | {
      readonly ok: true;
      readonly next: SetupRuntimeState;
      readonly noop: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Retry a blocked setup runtime: bump generation, reset attempts, back to
 * pending — the next execution re-runs it fresh. Idempotent: a call on an
 * already-pending runtime is a no-op success (a duplicated request must not
 * bump the generation twice). Any other state is a 409-worthy rejection.
 */
export function retrySetup(
  current: SetupRuntimeState | undefined,
): SetupControlResult {
  if (current?.state === "pending") {
    return { ok: true, next: current, noop: true };
  }
  if (current?.state !== "blocked") {
    return {
      ok: false,
      reason: `setup runtime is not blocked (state: ${current?.state ?? "unknown"}); only a blocked setup runtime can be retried`,
    };
  }
  return {
    ok: true,
    noop: false,
    next: {
      state: "pending",
      pluginVersion: current.pluginVersion,
      generation: current.generation + 1,
      attempts: 0,
    },
  };
}

/**
 * Waive a blocked setup runtime: mark it done with a degraded-mode warning so
 * the plugin's session gate is satisfied without the setup ever succeeding.
 * Idempotent: a call on an already-waived runtime is a no-op success.
 */
export function waiveSetup(
  current: SetupRuntimeState | undefined,
  now: string,
  warning: string,
): SetupControlResult {
  if (current?.state === "done" && current.resolution === "waived") {
    return { ok: true, next: current, noop: true };
  }
  if (current?.state !== "blocked") {
    return {
      ok: false,
      reason: `setup runtime is not blocked (state: ${current?.state ?? "unknown"}); only a blocked setup runtime can be waived`,
    };
  }
  return {
    ok: true,
    noop: false,
    next: {
      state: "done",
      resolution: "waived",
      generation: current.generation,
      attempts: current.attempts,
      completedAt: now,
      pluginVersion: current.pluginVersion,
      warning,
    },
  };
}
