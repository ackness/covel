import type { ExecutionStep, StreamMessage } from "./types.js";

export interface ExecutionTurn {
  readonly key: string;
  readonly turnId?: string;
  readonly messages: Array<{ message: StreamMessage; index: number }>;
  readonly steps: ExecutionStep[];
  timestamp: number;
  activityTimestamp: number;
  turnNumber?: number;
  /** Only the original source turn's commit permits individual task retries. */
  sourceCommitted?: boolean;
}

/** Resolve legacy retry chains without allowing malformed links to loop. */
export function getSourceTurnId(
  turnId: string | undefined,
  sources: ReadonlyMap<string, string>,
): string | undefined {
  if (!turnId) return turnId;
  let current = turnId;
  const seen = new Set<string>();
  while (sources.has(current)) {
    if (seen.has(current)) return turnId;
    seen.add(current);
    const source = sources.get(current)!;
    if (source === current) break;
    current = source;
  }
  return current;
}

export function retryStepMetadata(
  payload: Record<string, unknown>,
  turnId: string | undefined,
): Partial<ExecutionStep> {
  return typeof payload.sourceTurnId === "string" &&
    Array.isArray(payload.runtimeIds) &&
    payload.runtimeIds.length > 0 &&
    payload.sourceTurnId !== turnId
    ? {
        sourceTurnId: payload.sourceTurnId,
        attemptStatus: "pending",
        ...(payload.sourceCommitted === true
          ? {
              sourceCommitted: true,
              ...(Array.isArray(payload.sourceFailedRuntimeIds) &&
              payload.sourceFailedRuntimeIds.every(
                (id) => typeof id === "string",
              )
                ? {
                    sourceFailedRuntimeIds: [
                      ...new Set(payload.sourceFailedRuntimeIds as string[]),
                    ],
                  }
                : {}),
            }
          : {}),
      }
    : {};
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function projectedStep(step: ExecutionStep, turnId?: string): ExecutionStep {
  const retry = !!step.sourceTurnId && step.sourceTurnId !== step.turnId;
  const display = { ...step, turnId };
  if (!retry) return display;
  if (
    step.status === "suspended" &&
    step.attemptStatus !== "failed" &&
    step.attemptStatus !== "interrupted"
  )
    return {
      ...display,
      detail: step.detail ?? "__i18n:session.suspensionsDescription__",
    };
  if (
    (step.status !== "completed" && step.status !== "suspended") ||
    step.attemptStatus === "committed"
  )
    return display;
  return {
    ...display,
    status:
      step.attemptStatus === "failed" || step.attemptStatus === "interrupted"
        ? "failed"
        : "running",
    detail:
      step.attemptStatus === "interrupted"
        ? "__i18n:session.reasonInterrupted__"
        : step.attemptStatus === "failed"
          ? "__i18n:session.reasonCommitFailed__"
          : "__i18n:session.reasonAwaitingCommit__",
  };
}

/**
 * Player-facing turns keep their original place in history. Retrying a task
 * updates only that task, while the raw store keeps every real attempt ID.
 */
export function projectExecutionTurns(
  messages: readonly StreamMessage[],
  steps: readonly ExecutionStep[],
): { turns: ExecutionTurn[]; latestTurn?: ExecutionTurn } {
  const sources = new Map<string, string>();
  for (const step of steps) {
    if (step.turnId && step.sourceTurnId)
      sources.set(step.turnId, step.sourceTurnId);
  }
  const groups = new Map<string, ExecutionTurn>();
  const getGroup = (key: string, turnId?: string): ExecutionTurn => {
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        turnId,
        messages: [],
        steps: [],
        timestamp: Number.POSITIVE_INFINITY,
        activityTimestamp: Number.NEGATIVE_INFINITY,
      };
      groups.set(key, group);
    }
    return group;
  };
  const includeTime = (group: ExecutionTurn, value: string | undefined) => {
    const time = timestamp(value);
    if (!Number.isFinite(time)) return;
    group.timestamp = Math.min(group.timestamp, time);
    group.activityTimestamp = Math.max(group.activityTimestamp, time);
  };
  // Stable sorting also handles old persisted rows without timestamps. Later
  // attempts win by attempt time, never by the order local and server rows merge.
  const orderedSteps = [...steps].sort(
    (a, b) =>
      timestamp(a.turnStartedAt ?? a.startedAt) -
      timestamp(b.turnStartedAt ?? b.startedAt),
  );
  const summaries = new Map<
    string,
    { turnId?: string; order: number; failed: ReadonlySet<string> }
  >();
  const winnerOrders = new Map<string, number>();
  for (const [order, step] of orderedSteps.entries()) {
    const turnId = getSourceTurnId(step.turnId, sources);
    const group = getGroup(`turn:${turnId ?? "__unknown__"}`, turnId);
    if (step.turnId === turnId && step.attemptStatus) {
      const committed = step.attemptStatus === "committed";
      group.sourceCommitted = group.sourceCommitted === true || committed;
    }
    if (step.sourceTurnId && step.sourceCommitted === true) {
      group.sourceCommitted = true;
      if (
        step.sourceFailedRuntimeIds &&
        summaries.get(group.key)?.turnId !== step.turnId
      )
        summaries.set(group.key, {
          turnId: step.turnId,
          order,
          failed: new Set(step.sourceFailedRuntimeIds),
        });
    }
    includeTime(group, step.turnStartedAt ?? step.startedAt);
    const existing = group.steps.findIndex(
      (row) => row.runtimeId === step.runtimeId,
    );
    const previous = existing < 0 ? undefined : group.steps[existing];
    const notExecuted = step.sourceTurnId && step.status === "skipped";
    // A dependency failure can skip another selected task in the same batch.
    // That task is still unresolved; skipping must not erase its earlier failure.
    const projected = notExecuted
      ? (previous ?? {
          ...step,
          turnId,
          status: "failed" as const,
          detail: "__i18n:session.reasonRetryNotCompleted__",
        })
      : projectedStep(step, turnId);
    if (existing < 0) group.steps.push(projected);
    else group.steps[existing] = projected;
    if (!notExecuted || !previous)
      winnerOrders.set(`${group.key}|${step.runtimeId}`, order);
  }
  for (const group of groups.values()) {
    const summary = summaries.get(group.key);
    if (!summary) continue;
    // The newest scope replaces older failure summaries. Its committed terminal
    // ledger settles repairs; inflight results remain pending until that boundary.
    const effective = group.steps.flatMap((step) => {
      if (step.status === "failed" && !summary.failed.has(step.runtimeId))
        return [];
      if (
        (winnerOrders.get(`${group.key}|${step.runtimeId}`) ?? -1) >=
        summary.order
      )
        return [step];
      if (summary.failed.has(step.runtimeId))
        return [
          {
            ...step,
            status: "failed" as const,
            detail:
              step.status === "failed"
                ? step.detail
                : "__i18n:session.reasonRetryNotCompleted__",
          },
        ];
      // Missing from the current failure ledger does not prove success: an old
      // failed row may have been repaired outside the retained trace window.
      // Hide that stale copy.
      return step.status === "failed" ? [] : [step];
    });
    for (const runtimeId of summary.failed) {
      if (!effective.some((step) => step.runtimeId === runtimeId))
        effective.push({
          runtimeId,
          // The summary carries only IDs. Use that as a display fallback until
          // a runtime event supplies its actual plugin metadata.
          pluginId: runtimeId,
          turnId: group.turnId,
          status: "failed",
          detail: "__i18n:session.reasonRetryNotCompleted__",
        });
    }
    group.steps.splice(0, group.steps.length, ...effective);
  }
  messages.forEach((message, index) => {
    const turnId = getSourceTurnId(message.turnId, sources);
    const group = getGroup(
      turnId ? `turn:${turnId}` : `message:${message.id}`,
      turnId,
    );
    group.messages.push({ message, index });
    includeTime(group, message.timestamp);
  });
  const turns = [...groups.values()].sort((a, b) => a.timestamp - b.timestamp);
  let latestTurn: ExecutionTurn | undefined;
  let turnNumber = 0;
  for (const group of turns) {
    if (!group.turnId && group.steps.length === 0) continue;
    group.turnNumber = ++turnNumber;
    if (!latestTurn || group.activityTimestamp >= latestTurn.activityTimestamp)
      latestTurn = group;
  }
  return { turns, latestTurn };
}
