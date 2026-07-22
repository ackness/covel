import type { RuntimeManifest, SetupRuntimeState } from "@covel/shared";
import {
  getRuntimeSpec,
  isSetupDoneForVersion,
  isSetupRuntime,
} from "@covel/shared";
import type { TurnMessageRecord } from "@covel/store";
import { scheduleByDag } from "../schedule/dag-scheduler.js";
import {
  isMainLoopPriority,
  isPreGamePriority,
  NARRATOR_PRIORITY,
  scheduleByPriority,
} from "../schedule/scheduler.js";
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

  const triggered = activeRuntimes.filter((rt) => {
    // Setup runtimes: scheduled by mirror state (pending), not turn cadence.
    if (isSetupRuntime(rt)) {
      return setupRuntimePending(rt, setupRuntimes, preGameCompleted);
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
    return {
      groups: [
        {
          priority:
            getRuntimeSpec(manualTarget).legacyOrder ?? NARRATOR_PRIORITY,
          runtimes: [manualTarget],
        },
      ],
      cyclic: [],
    };
  }

  if (isPreGamePending) {
    const preGameTriggered = triggered.filter((rt) =>
      isPreGamePriority(getRuntimeSpec(rt).legacyOrder),
    );
    return { groups: scheduleByPriority(preGameTriggered, 0), cyclic: [] };
  }

  const mainLoop = triggered.filter((rt) =>
    isMainLoopPriority(getRuntimeSpec(rt).legacyOrder),
  );
  const dag = scheduleByDag(mainLoop);
  if (dag.error) {
    // Deliberate change: no fall-back to priority ordering. Disable the SCC
    // (and its downstream) — the executor skips them `dependency-cycle` with
    // the full path diagnostic — and run the acyclic remainder as scheduled.
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
