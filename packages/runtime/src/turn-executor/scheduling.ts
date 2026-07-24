import type { RuntimeManifest, SetupRuntimeState, Stage } from "@covel/shared";
import {
  getRuntimeSpec,
  isMainLoopRuntime,
  isSetupDoneForVersion,
  isSetupRuntime,
  STAGE_ORDER,
} from "@covel/shared";
import type { TurnMessageRecord } from "@covel/store";
import { scheduleByDag } from "../schedule/dag-scheduler.js";
import { shouldTrigger } from "../trigger/trigger.js";
import type { ScheduledGroup, TriggerContext } from "../types.js";

export interface TriggeredRuntimeSelection {
  readonly manualTarget: RuntimeManifest | undefined;
  readonly triggered: readonly RuntimeManifest[];
  readonly abortReason: string | undefined;
}

/**
 * A schedule plus the runtimes that could not be placed because they sit in (or
 * downstream of) a dependency cycle. Cyclic members are disabled for the turn
 * (`skipped: dependency-cycle`) — the deliberate replacement for the old
 * fall-back-to-priority-ordering behaviour, which silently ran cyclic runtimes
 * in an arbitrary order.
 */
export interface ScheduleResult {
  readonly groups: readonly ScheduledGroup[];
  readonly cyclic: readonly RuntimeManifest[];
}

/**
 * Whether a setup runtime should run this turn, from its persistent mirror:
 * pending (or never-run, absent from the mirror and the legacy set) → yes;
 * blocked or done → no. Setup scheduling is governed by the ledger-based retry
 * budget (blocked), not turn cadence, so `shouldTrigger` is bypassed for them.
 */
function setupRuntimePending(
  rt: RuntimeManifest,
  setupRuntimes: Readonly<Record<string, SetupRuntimeState>>,
  preGameCompleted: readonly string[],
): boolean {
  const mirror = setupRuntimes[rt.name];
  if (mirror?.state === "blocked") return false;
  if (mirror?.state === "done") {
    // Re-run a `done` setup runtime when the plugin version changed — the old
    // completion no longer satisfies the gate. Same version → stays done.
    return !isSetupDoneForVersion(mirror, rt.version);
  }
  // No mirror: fall back to the legacy `preGameCompleted` signal.
  if (preGameCompleted.includes(rt.name)) return false;
  return true;
}

/** A setup target counts as done from the frozen snapshot (mirror or legacy signal). */
function isSetupTargetDone(
  target: RuntimeManifest,
  setupRuntimes: Readonly<Record<string, SetupRuntimeState>>,
  preGameCompleted: readonly string[],
): boolean {
  const mirror = setupRuntimes[target.name];
  if (mirror?.state === "done") {
    return isSetupDoneForVersion(mirror, target.version);
  }
  return preGameCompleted.includes(target.name);
}

/** One-shot diagnostics for unsatisfiable session gates (per session+runtime+target). */
const _sessionGateWarned = new Set<string>();

/**
 * Positive `needs(scope: session)` gate for setup runtimes: every session-scope
 * need must resolve to a target that is `done` in the persistent snapshot
 * frozen at execution start. Unsatisfied → the consumer is NOT selected this
 * execution (it stays pending; a done produced by this execution becomes
 * visible to the NEXT one). A target that is absent from the active setup set
 * can never satisfy the gate — warn once so the author sees why the runtime
 * never runs (the session stays in setup until the plugin set changes, the
 * same standing as a `blocked` producer).
 */
function setupSessionGateSatisfied(
  rt: RuntimeManifest,
  activeSetupRuntimes: readonly RuntimeManifest[],
  setupRuntimes: Readonly<Record<string, SetupRuntimeState>>,
  preGameCompleted: readonly string[],
  sessionId: string,
): boolean {
  const warnUnsatisfiable = (targetLabel: string): void => {
    const key = `${sessionId}:${rt.name}:${targetLabel}`;
    if (_sessionGateWarned.has(key)) return;
    if (_sessionGateWarned.size > 256) _sessionGateWarned.clear();
    _sessionGateWarned.add(key);
    console.warn(
      `[scheduling] setup runtime "${rt.name}" declares needs(scope: session) on ` +
        `${targetLabel}, which has no provider in the active setup set — the gate can ` +
        `never be satisfied and the runtime will not run until the plugin set changes.`,
    );
  };

  for (const need of getRuntimeSpec(rt).deps.needs) {
    // Bare-string / turn-scope entries are same-execution gates (handled by
    // the upstream gate in turn-runtime-execution), not session ones.
    if (typeof need === "string" || need.scope !== "session") continue;
    if ("runtime" in need) {
      const target = activeSetupRuntimes.find((r) => r.name === need.runtime);
      if (!target) {
        warnUnsatisfiable(`runtime "${need.runtime}"`);
        return false;
      }
      if (!isSetupTargetDone(target, setupRuntimes, preGameCompleted)) {
        return false;
      }
    } else {
      const providers = activeSetupRuntimes.filter((r) =>
        r.capabilities?.includes(need.capability),
      );
      if (providers.length === 0) {
        warnUnsatisfiable(`capability "${need.capability}"`);
        return false;
      }
      const doneCount = providers.filter((p) =>
        isSetupTargetDone(p, setupRuntimes, preGameCompleted),
      ).length;
      const satisfied =
        (need.cardinality ?? "one") === "all"
          ? doneCount === providers.length
          : doneCount > 0;
      if (!satisfied) return false;
    }
  }
  return true;
}

export function selectTriggeredRuntimes(args: {
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly manualRuntimeId: string | undefined;
  readonly messageHistory: readonly TurnMessageRecord[];
  readonly preGameCompleted: readonly string[];
  readonly runtimeTriggerCounts: ReadonlyMap<string, number>;
  readonly setupRuntimes: Readonly<Record<string, SetupRuntimeState>>;
  readonly sessionId: string;
  readonly turnNumber: number;
  /** Logical-turn number (completedPlayerTurns + 1), frozen for this execution. */
  readonly logicalTurn: number;
}): TriggeredRuntimeSelection {
  const {
    activeRuntimes,
    manualRuntimeId,
    messageHistory,
    preGameCompleted,
    runtimeTriggerCounts,
    setupRuntimes,
    sessionId,
    turnNumber,
    logicalTurn,
  } = args;
  const manualTarget = manualRuntimeId
    ? activeRuntimes.find((rt) => rt.name === manualRuntimeId)
    : undefined;

  if (manualRuntimeId && !manualTarget) {
    return {
      manualTarget,
      triggered: [],
      abortReason: `manual-trigger: runtime not found or inactive: ${manualRuntimeId}`,
    };
  }

  if (manualTarget) {
    return { manualTarget, triggered: [manualTarget], abortReason: undefined };
  }

  const activeSetupRuntimes = activeRuntimes.filter(isSetupRuntime);
  const triggered = activeRuntimes.filter((rt) => {
    // Setup runtimes: scheduled by mirror state (pending), not turn cadence,
    // then gated on their `needs(scope: session)` targets being done in the
    // frozen snapshot.
    if (isSetupRuntime(rt)) {
      return (
        setupRuntimePending(rt, setupRuntimes, preGameCompleted) &&
        setupSessionGateSatisfied(
          rt,
          activeSetupRuntimes,
          setupRuntimes,
          preGameCompleted,
          sessionId,
        )
      );
    }
    const triggerContext: TriggerContext = {
      sessionId,
      turnNumber,
      logicalTurn,
      triggerCount: runtimeTriggerCounts.get(rt.name) ?? 0,
      turnsSinceLastTrigger: countPlayerMessagesSinceRuntime(
        messageHistory,
        rt.name,
      ),
      pendingEventTopics: [],
      isManualTrigger: false,
      preGameCompleted,
    };
    return shouldTrigger(rt, triggerContext);
  });

  return { manualTarget, triggered, abortReason: undefined };
}

export function scheduleTriggeredRuntimes(args: {
  readonly manualTarget: RuntimeManifest | undefined;
  readonly triggered: readonly RuntimeManifest[];
  readonly isPreGamePending: boolean;
}): ScheduleResult {
  const { manualTarget, triggered, isPreGamePending } = args;

  if (manualTarget) {
    return { groups: [{ runtimes: [manualTarget] }], cyclic: [] };
  }

  // Setup band (`phase: setup`): the `stage === "setup"` runtimes, ordered
  // purely by their declared edges (pregame → schema-gen is an authored
  // `after` edge; player-init gates on both via turn-scoped `needs`).
  if (isPreGamePending) {
    return runDag(triggered.filter(isSetupRuntime));
  }

  // Main loop: run each stage (pre-turn → narrative → post-turn → audit) as an
  // independent DAG, concatenating the level-groups in stage order. The executor
  // runs groups sequentially, so ordering the groups by stage IS the strict
  // barrier — a later stage never starts until the earlier one drains. Within a
  // stage, the DAG parallelizes independent branches (name breaks ties). A
  // cross-stage `needs` (e.g. post-turn → narrative-engine) resolves out of the
  // per-stage DAG's scope and is satisfied by the barrier + the upstream gate.
  const mainLoop = triggered.filter(isMainLoopRuntime);
  return scheduleMainLoopByStage(mainLoop);
}

const MAIN_LOOP_STAGES: readonly Stage[] = STAGE_ORDER.filter(
  (s) => s !== "setup",
);

function scheduleMainLoopByStage(
  runtimes: readonly RuntimeManifest[],
): ScheduleResult {
  const byStage = new Map<Stage, RuntimeManifest[]>();
  for (const rt of runtimes) {
    const stage = getRuntimeSpec(rt).stage;
    if (stage === undefined) continue;
    (byStage.get(stage) ?? byStage.set(stage, []).get(stage)!).push(rt);
  }

  const groups: ScheduledGroup[] = [];
  const cyclic: RuntimeManifest[] = [];
  for (const stage of MAIN_LOOP_STAGES) {
    const stageRuntimes = byStage.get(stage);
    if (!stageRuntimes || stageRuntimes.length === 0) continue;
    const result = runDag(stageRuntimes);
    groups.push(...result.groups);
    cyclic.push(...result.cyclic);
  }
  return { groups, cyclic };
}

function runDag(runtimes: readonly RuntimeManifest[]): ScheduleResult {
  const dag = scheduleByDag(runtimes);
  if (dag.error) {
    // No fall-back to a plain sort: disable the SCC (and its downstream) — the
    // executor skips them `dependency-cycle` with the full path diagnostic —
    // and run the acyclic remainder as scheduled.
    console.warn(`[turn-executor] DAG scheduler: ${dag.error}`);
  }
  return { groups: dag.groups, cyclic: dag.cyclic ?? [] };
}

/**
 * `messageHistory` is the uncompacted suffix of the session timeline. If a
 * runtime's last trigger was compacted away, the backward scan misses it and
 * returns the not-found sentinel (999) — erring toward triggering, which is
 * safe: the compactor's protect window keeps recent turns raw, so any message
 * old enough to be compacted is at least a protect-window's worth of player
 * turns in the past.
 */
export function countPlayerMessagesSinceRuntime(
  messageHistory: readonly TurnMessageRecord[],
  runtimeId: string,
): number {
  let lastRuntimeMsgIdx = -1;
  for (let i = messageHistory.length - 1; i >= 0; i--) {
    const msg = messageHistory[i];
    if (msg.sourceType === "runtime" && msg.sourceRuntimeId === runtimeId) {
      lastRuntimeMsgIdx = i;
      break;
    }
  }

  if (lastRuntimeMsgIdx < 0) return 999;

  return messageHistory
    .slice(lastRuntimeMsgIdx)
    .filter((msg) => msg.sourceType === "player").length;
}
