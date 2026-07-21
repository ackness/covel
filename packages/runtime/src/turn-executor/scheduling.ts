import type { RuntimeManifest } from "@covel/shared";
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

export function selectTriggeredRuntimes(args: {
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly manualRuntimeId: string | undefined;
  readonly messageHistory: readonly TurnMessageRecord[];
  readonly preGameCompleted: readonly string[];
  readonly runtimeTriggerCounts: ReadonlyMap<string, number>;
  readonly sessionId: string;
  readonly turnNumber: number;
}): TriggeredRuntimeSelection {
  const {
    activeRuntimes,
    manualRuntimeId,
    messageHistory,
    preGameCompleted,
    runtimeTriggerCounts,
    sessionId,
    turnNumber,
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
    const triggerContext: TriggerContext = {
      sessionId,
      turnNumber,
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
  readonly turnNumber: number;
}): readonly ScheduledGroup[] {
  const { manualTarget, triggered, isPreGamePending, turnNumber } = args;

  if (manualTarget) {
    return [
      {
        priority: manualTarget.priority ?? NARRATOR_PRIORITY,
        runtimes: [manualTarget],
      },
    ];
  }

  if (isPreGamePending) {
    const preGameTriggered = triggered.filter((rt) =>
      isPreGamePriority(rt.priority),
    );
    return scheduleByPriority(preGameTriggered, 0);
  }

  const mainLoop = triggered.filter((rt) => isMainLoopPriority(rt.priority));
  const dag = scheduleByDag(mainLoop);
  if (dag.error) {
    console.warn(
      `[turn-executor] DAG scheduler: ${dag.error}; falling back to priority ordering`,
    );
    return scheduleByPriority(triggered, turnNumber);
  }
  return dag.groups;
}

export function scheduleMainLoopFollowups(args: {
  readonly triggered: readonly RuntimeManifest[];
  readonly completedRuntimeIds: ReadonlySet<string>;
  readonly turnNumber: number;
}): readonly ScheduledGroup[] {
  const mainLoop = args.triggered.filter(
    (rt) =>
      isMainLoopPriority(rt.priority) && !args.completedRuntimeIds.has(rt.name),
  );
  const dag = scheduleByDag(mainLoop);
  return dag.error ? scheduleByPriority(mainLoop, args.turnNumber) : dag.groups;
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
