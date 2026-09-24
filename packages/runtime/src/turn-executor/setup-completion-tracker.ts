/**
 * SetupCompletionTracker — the single owner of setup-completion state for one
 * `executeTurnImpl` run.
 *
 * Previously this state was scattered across the executor as five mutable
 * cells (the setup mirror snapshot, the live done-set, the newly-done delta,
 * the all-done flag, and the "observed" flag deciding whether
 * `TurnResult.setupCompletion` appears) maintained by two closures plus an
 * unnamed inline fold. The tracker collapses them behind one object:
 *
 * - `mirror` — the setup-runtimes mirror this execution reads and patches
 *   (session-cycle blocking + pre-game completion merges).
 * - `isSetupRuntimeDone` / `pluginSetupReady` — the live gate the scheduler
 *   and the implicit per-plugin session gate read BY REFERENCE, so a setup
 *   runtime that completes mid-turn unblocks its plugin's main runtimes in
 *   the same turn (the late-setup → main-loop catch-up in the playing band).
 * - `syncLiveDone` — folds this turn's done signals into the live done-set.
 * - `recordPreGameCompletion` — projects explicit completion signals into
 *   the mirror delta (idempotent; called both before the event chain and
 *   again after it).
 * - `foldSetupRan` — the playing-band (late-setup) path: derives done
 *   mirrors for ledger entries `recordPreGameCompletion` did not observe.
 *   This is the playing band's ONLY writer of the newly-done delta and must
 *   not be dropped in future refactors.
 * - `setupCompletion` — the `TurnResult.setupCompletion` payload, present
 *   only when this execution actually observed setup activity.
 */

import type {
  RanSetupRuntime,
  RuntimeManifest,
  RuntimeResult,
  SetupRuntimeState,
} from "@covel/shared";
import { mirrorSetupDone } from "@covel/shared";
import { markPreGameCompletion } from "./pre-game-completion.js";
import {
  classifySetupResult,
  initialDoneSetup,
  makePluginSetupReady,
} from "./setup-run.js";

export interface SetupCompletionTrackerArgs {
  /** Active setup-stage runtimes for this session. */
  readonly activeSetupRuntimes: readonly RuntimeManifest[];
  /** Committed setup mirror frozen at execution start. */
  readonly setupRuntimes: Readonly<Record<string, SetupRuntimeState>>;
  /** Setup runtimes counted for Pre-Game completion (setup band). */
  readonly preGameRuntimes: readonly RuntimeManifest[];
  readonly isPreGamePending: boolean;
  readonly isManualTrigger: boolean;
}

/** The `TurnResult.setupCompletion` payload shape. */
export interface SetupCompletionDelta {
  readonly newlyDone: Readonly<Record<string, SetupRuntimeState>>;
  readonly allSetupDone: boolean;
}

export class SetupCompletionTracker {
  private readonly args: SetupCompletionTrackerArgs;
  private currentMirror: Record<string, SetupRuntimeState>;
  /**
   * Live done-set the session gate reads. Seeded from committed state; the
   * late-setup pass adds runtimes that complete within THIS turn.
   */
  private readonly liveDone: Set<string>;
  /**
   * Setup-completion delta accumulated across the (idempotent) completion
   * passes, handed to the finalizer so the session-clock write (setup mirror +
   * phase flip) lands in the commit transaction.
   */
  private readonly newlyDone: Record<string, SetupRuntimeState> = {};
  /** Last observed all-done value — once every setup runtime resolved it stays true. */
  private allDone = false;
  /** Whether `TurnResult.setupCompletion` should appear at all. */
  private observed = false;
  /** Per-plugin implicit session gate; reads `liveDone` by reference. */
  readonly pluginSetupReady: (pluginId: string) => boolean;

  constructor(args: SetupCompletionTrackerArgs) {
    this.args = args;
    this.currentMirror = { ...args.setupRuntimes };
    this.liveDone = initialDoneSetup(
      args.activeSetupRuntimes,
      this.currentMirror,
    );
    this.pluginSetupReady = makePluginSetupReady(
      args.activeSetupRuntimes,
      this.liveDone,
    );
  }

  /** The setup mirror this execution schedules and settles against. */
  get mirror(): Readonly<Record<string, SetupRuntimeState>> {
    return this.currentMirror;
  }

  /**
   * Block the members of a `needs(scope: session)` cycle: such a cycle can
   * never resolve (a session-scope need reads a PERSISTED done state), so the
   * members are marked `blocked` up front — no run, no attempt burned. Returns
   * the patched mirror for the caller to persist.
   */
  blockSessionCycles(
    cycles: ReadonlyMap<string, readonly string[]>,
    blockedAt: string,
  ): Record<string, SetupRuntimeState> {
    const patched: Record<string, SetupRuntimeState> = {
      ...this.currentMirror,
    };
    for (const [name, path] of cycles) {
      const manifest = this.args.activeSetupRuntimes.find(
        (r) => r.name === name,
      );
      const prev = this.currentMirror[name];
      patched[name] = {
        state: "blocked",
        pluginVersion: manifest?.version ?? "0.0.0",
        generation: prev?.generation ?? 1,
        attempts: prev?.attempts ?? 0,
        reason: `setup-session-cycle: ${path.join(" → ")}`,
        blockedAt,
      };
    }
    this.currentMirror = patched;
    return patched;
  }

  /** Live done predicate (the `setupRuntimeDone` gate for runtime invocation). */
  isSetupRuntimeDone(runtimeId: string): boolean {
    return this.liveDone.has(runtimeId);
  }

  /**
   * Add every setup runtime that reported done this turn to the live done-set,
   * so a plugin whose setup just completed unblocks its main runtimes within
   * the same turn. Idempotent.
   */
  syncLiveDone(completedResults: ReadonlyMap<string, RuntimeResult>): void {
    for (const rt of this.args.activeSetupRuntimes) {
      if (this.liveDone.has(rt.name)) continue;
      const result = completedResults.get(rt.name);
      if (result && classifySetupResult(result).doneSignal) {
        this.liveDone.add(rt.name);
      }
    }
  }

  /**
   * Project explicit Pre-Game completion signals into the mirror delta and
   * refresh the live done-set. Idempotent; safe to call multiple times per
   * execution (before the event chain and again after it).
   */
  recordPreGameCompletion(
    completedResults: ReadonlyMap<string, RuntimeResult>,
  ): boolean {
    const result = markPreGameCompletion({
      completedResults,
      isPreGamePending: this.args.isPreGamePending,
      isManualTrigger: this.args.isManualTrigger,
      preGameRuntimes: this.args.preGameRuntimes,
      setupRuntimes: this.currentMirror,
    });
    if (this.args.isPreGamePending && !this.args.isManualTrigger) {
      this.observed = true;
      Object.assign(this.newlyDone, result.newlyDone);
      this.currentMirror = {
        ...this.currentMirror,
        ...result.newlyDone,
      };
      this.allDone = result.allDone;
    }
    this.syncLiveDone(completedResults);
    return result.allDone;
  }

  /**
   * Playing-band fold: derive done mirrors for late-setup ledger entries that
   * `recordPreGameCompletion` did not observe, and mark setup activity as
   * observed so the delta reaches `TurnResult.setupCompletion`.
   */
  foldSetupRan(setupRan: readonly RanSetupRuntime[]): void {
    for (const r of setupRan) {
      if (r.doneSignal && !(r.runtimeId in this.newlyDone)) {
        const previous = this.currentMirror[r.runtimeId];
        this.newlyDone[r.runtimeId] = mirrorSetupDone(
          r.pluginVersion,
          r.startedAt,
          r.generation,
          previous?.generation === r.generation ? previous.attempts + 1 : 1,
        );
      }
    }
    if (setupRan.length > 0) this.observed = true;
  }

  /**
   * The `TurnResult.setupCompletion` payload — undefined when this execution
   * never observed setup completion (manual / non-setup paths), keeping the
   * field absent exactly as the scattered-state implementation did.
   */
  get setupCompletion(): SetupCompletionDelta | undefined {
    if (!this.observed) return undefined;
    return { newlyDone: this.newlyDone, allSetupDone: this.allDone };
  }
}
