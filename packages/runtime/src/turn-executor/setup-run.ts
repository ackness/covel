/**
 * Setup-runtime execution helpers for the turn executor: classify a setup
 * result into ledger + completion signals, collect the ran-setup ledger
 * entries, and derive the per-plugin implicit session gate.
 *
 * The implicit session gate (`isPluginSetupReady`) is the mechanism behind
 * scenario 2: a non-setup runtime is skipped (`setup-incomplete`) while any of
 * its own plugin's active setup runtimes is not yet done. It reads a LIVE
 * done-set so a setup runtime that completes earlier in the same turn (the
 * late-setup pass) unblocks its plugin's main runtimes within that turn.
 */

import type {
  RuntimeManifest,
  RuntimeResult,
  SetupRuntimeState,
} from "@covel/shared";
import {
  getRuntimeSpec,
  isSetupDoneForVersion,
  isSetupRuntime,
  resolveSetupGeneration,
  setupRetryBudget,
} from "@covel/shared";
import type { RanSetupRuntime } from "../commit/setup-settle.js";

interface SetupResultClass {
  /** Did the runtime enter its guard/handler (i.e. spend an attempt)? */
  readonly ran: boolean;
  /** Did it signal completion (completion: done / guard skip)? */
  readonly doneSignal: boolean;
  readonly ledgerState: "success" | "failed" | "skipped";
  readonly error?: string;
}

/** Classify a setup runtime's result into ledger + completion signals. */
export function classifySetupResult(result: RuntimeResult): SetupResultClass {
  const output = result.output as Record<string, unknown> | undefined;
  // Framework gate skip (needs / dependency-cycle / setup-incomplete)
  // short-circuits before the guard/handler → no attempt is spent.
  if (result.status === "skipped" && output?.skipped === true) {
    return { ran: false, doneSignal: false, ledgerState: "skipped" };
  }
  // Guard skip — the guard ran and decided the setup was unnecessary → done.
  if (result.status === "skipped" && output?.skip === true) {
    return { ran: true, doneSignal: true, ledgerState: "skipped" };
  }
  if (result.status === "failed") {
    return {
      ran: true,
      doneSignal: false,
      ledgerState: "failed",
      ...(result.error ? { error: result.error } : {}),
    };
  }
  return {
    ran: true,
    doneSignal: result.completion === "done",
    ledgerState: "success",
  };
}

/**
 * Build the ledger entries for every setup runtime that ran in this execution.
 * Framework-gate skips (no guard/handler reached) produce no entry.
 */
export function collectSetupRan(args: {
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly setupRuntimes: Readonly<Record<string, SetupRuntimeState>>;
  readonly executionId: string;
}): RanSetupRuntime[] {
  const { activeRuntimes, completedResults, setupRuntimes, executionId } = args;
  const byName = new Map(activeRuntimes.map((rt) => [rt.name, rt]));
  const ran: RanSetupRuntime[] = [];
  for (const [name, result] of completedResults) {
    const manifest = byName.get(name);
    if (!manifest || !isSetupRuntime(manifest)) continue;
    const cls = classifySetupResult(result);
    if (!cls.ran) continue;
    ran.push({
      runtimeId: name,
      pluginVersion: manifest.version ?? "0.0.0",
      generation: resolveSetupGeneration(manifest.version, setupRuntimes[name]),
      executionId,
      startedAt: result.timestamp,
      doneSignal: cls.doneSignal,
      ledgerState: cls.ledgerState,
      budget: setupRetryBudget(manifest),
      ...(cls.error ? { error: cls.error } : {}),
    });
  }
  return ran;
}

/**
 * Setup runtimes that count as satisfied at execution start. A `done` mirror
 * only counts while the plugin version is unchanged.
 */
export function initialDoneSetup(
  activeSetupRuntimes: readonly RuntimeManifest[],
  setupRuntimes: Readonly<Record<string, SetupRuntimeState>>,
): Set<string> {
  const done = new Set<string>();
  for (const rt of activeSetupRuntimes) {
    const mirror = setupRuntimes[rt.name];
    if (mirror && isSetupDoneForVersion(mirror, rt.version)) done.add(rt.name);
  }
  return done;
}

/**
 * Per-plugin implicit session gate. A plugin is "setup ready" iff every one of
 * its active setup runtimes is in `liveDone`. Reads `liveDone` by reference so a
 * setup runtime that completes mid-turn flips its plugin ready within the turn.
 * A plugin with no active setup runtime is trivially ready.
 */
export function makePluginSetupReady(
  activeSetupRuntimes: readonly RuntimeManifest[],
  liveDone: ReadonlySet<string>,
): (pluginId: string) => boolean {
  const byPlugin = new Map<string, string[]>();
  for (const rt of activeSetupRuntimes) {
    const list = byPlugin.get(rt.pluginId) ?? [];
    list.push(rt.name);
    byPlugin.set(rt.pluginId, list);
  }
  return (pluginId) =>
    (byPlugin.get(pluginId) ?? []).every((name) => liveDone.has(name));
}

/**
 * Detect cycles in the `needs(scope: session)` graph of the active setup
 * runtimes, returning each cyclic member mapped to the full stuck set for
 * diagnostics. A session-scope need reads a producer's PERSISTED done state,
 * so a cycle can never resolve within the setup band — the members are blocked
 * (`setup-session-cycle`) rather than run. Only explicit `needs(scope: session)`
 * edges count; the implicit per-plugin gate does not (it only skips, it does not
 * create a reverse dependency).
 *
 * A need waits on pending runtimes only. A target that is already done
 * satisfies it, and a blocked or absent one leaves it to the player (retry,
 * waive, or a changed plugin set), so neither is a cycle edge. A capability
 * need follows the selection gate's cardinality: `all` waits for every pending
 * provider, `one` for any of them — and for none once a provider is done or
 * blocked. Whatever can never be released this way is in (or downstream of) a
 * cycle.
 */
export function detectSetupSessionCycles(
  activeSetupRuntimes: readonly RuntimeManifest[],
  setupRuntimes: Readonly<Record<string, SetupRuntimeState>>,
): Map<string, string[]> {
  const isPending = (rt: RuntimeManifest): boolean => {
    const mirror = setupRuntimes[rt.name];
    return (
      mirror?.state !== "blocked" && !isSetupDoneForVersion(mirror, rt.version)
    );
  };
  const pending = activeSetupRuntimes.filter(isPending);
  const pendingNames = new Set(pending.map((rt) => rt.name));

  // Per runtime, the groups of pending runtimes it waits for: a group is
  // released once any one of its members can complete.
  const waits = new Map<string, string[][]>();
  for (const rt of pending) {
    const groups: string[][] = [];
    for (const need of getRuntimeSpec(rt).deps.needs) {
      // Bare string / turn-scope entries are same-turn gates, not session ones.
      if (typeof need === "string" || need.scope !== "session") continue;
      if ("runtime" in need) {
        if (pendingNames.has(need.runtime)) groups.push([need.runtime]);
        continue;
      }
      const providers = activeSetupRuntimes.filter(
        (provider) => provider.outputContract === need.capability,
      );
      const pendingProviders = providers
        .filter(isPending)
        .map((provider) => provider.name);
      if ((need.cardinality ?? "one") === "all") {
        for (const name of pendingProviders) groups.push([name]);
      } else if (
        pendingProviders.length > 0 &&
        pendingProviders.length === providers.length
      ) {
        groups.push(pendingProviders);
      }
    }
    waits.set(rt.name, groups);
  }

  // Release every runtime whose groups can all be satisfied, until none remain.
  const released = new Set<string>();
  while (true) {
    const ready = pending.filter(
      (rt) =>
        !released.has(rt.name) &&
        waits
          .get(rt.name)!
          .every((group) => group.some((name) => released.has(name))),
    );
    if (ready.length === 0) break;
    for (const rt of ready) released.add(rt.name);
  }

  const stuck = pending
    .map((rt) => rt.name)
    .filter((name) => !released.has(name));
  const cycles = new Map<string, string[]>();
  for (const name of stuck) cycles.set(name, stuck);
  return cycles;
}
