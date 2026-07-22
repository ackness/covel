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
  /** Did it signal completion (preGameDone / guard skip)? */
  readonly doneSignal: boolean;
  readonly ledgerState: "success" | "failed" | "skipped";
  readonly error?: string;
}

/** Classify a setup runtime's result into ledger + completion signals. */
export function classifySetupResult(result: RuntimeResult): SetupResultClass {
  const output = result.output as Record<string, unknown> | undefined;
  // Framework gate skip (upstreamRequired / dependency-cycle / setup-incomplete)
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
    doneSignal: output?.preGameDone === true,
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
 * Setup runtimes that count as satisfied at execution start — mirror `done`
 * (incl. waived) or the legacy `preGameCompleted` signal for pre-mirror
 * sessions. Seeds the live done-set the session gate reads.
 */
export function initialDoneSetup(
  activeSetupRuntimes: readonly RuntimeManifest[],
  setupRuntimes: Readonly<Record<string, SetupRuntimeState>>,
  preGameCompleted: readonly string[],
): Set<string> {
  const done = new Set<string>();
  for (const rt of activeSetupRuntimes) {
    const mirror = setupRuntimes[rt.name];
    if (mirror) {
      // A `done` mirror only counts while the plugin version is unchanged; a
      // version bump invalidates it (re-run under a new generation).
      if (isSetupDoneForVersion(mirror, rt.version)) done.add(rt.name);
    } else if (preGameCompleted.includes(rt.name)) {
      // Pre-mirror (legacy) session: fall back to the completion signal.
      done.add(rt.name);
    }
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
 * Detect cycles in the `needs(scope: session)` graph among a set of pending
 * setup runtimes, returning each cyclic member mapped to the full stuck set for
 * diagnostics. A session-scope need reads a producer's PERSISTED done state,
 * so a cycle can never resolve within the setup band — the members are blocked
 * (`setup-session-cycle`) rather than run. Only explicit `needs(scope: session)`
 * edges count; the implicit per-plugin gate does not (it only skips, it does not
 * create a reverse dependency). Kahn-style: whatever cannot be topo-ordered is
 * in (or downstream of) a cycle.
 */
export function detectSetupSessionCycles(
  pendingSetup: readonly RuntimeManifest[],
): Map<string, string[]> {
  const inScope = new Set(pendingSetup.map((r) => r.name));
  const capabilityProviders = new Map<string, string[]>();
  for (const rt of pendingSetup) {
    for (const cap of rt.capabilities ?? []) {
      const list = capabilityProviders.get(cap) ?? [];
      list.push(rt.name);
      capabilityProviders.set(cap, list);
    }
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const rt of pendingSetup) inDegree.set(rt.name, 0);

  for (const rt of pendingSetup) {
    const targets = new Set<string>();
    for (const need of getRuntimeSpec(rt).deps.needs) {
      // Bare string / turn-scope entries are same-turn gates, not session ones.
      if (typeof need === "string" || need.scope !== "session") continue;
      if ("runtime" in need) {
        if (inScope.has(need.runtime)) targets.add(need.runtime);
      } else {
        for (const name of capabilityProviders.get(need.capability) ?? []) {
          targets.add(name);
        }
      }
    }
    for (const dep of targets) {
      inDegree.set(rt.name, (inDegree.get(rt.name) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(rt.name);
      dependents.set(dep, list);
    }
  }

  // Kahn: peel off zero-in-degree nodes until none remain.
  while (true) {
    const ready = [...inDegree.entries()].filter(([, deg]) => deg === 0);
    if (ready.length === 0) break;
    for (const [name] of ready) {
      inDegree.delete(name);
      for (const down of dependents.get(name) ?? []) {
        inDegree.set(down, (inDegree.get(down) ?? 0) - 1);
      }
    }
  }

  const stuck = [...inDegree.keys()];
  const cycles = new Map<string, string[]>();
  for (const name of stuck) cycles.set(name, stuck);
  return cycles;
}
