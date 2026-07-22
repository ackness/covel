import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import { getRuntimeSpec } from "@covel/shared";
import type { SessionContextSnapshot } from "@covel/context";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
import type { TurnSessionMeta } from "./session-state.js";
import { isPreGamePriority } from "../schedule/scheduler.js";

export interface MarkPreGameCompletionResult {
  readonly allDone: boolean;
  readonly preGameCompleted: readonly string[];
  readonly sessionMeta: TurnSessionMeta;
  readonly sessionContext: SessionContextSnapshot | undefined;
}

export async function markPreGameCompletion(args: {
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly deps: TurnExecutorDeps;
  readonly input: TurnInput;
  readonly isPreGamePending: boolean;
  readonly preGameRuntimes: readonly RuntimeManifest[];
  readonly preGameCompleted: readonly string[];
  readonly runtimeTriggerCounts: ReadonlyMap<string, number>;
  readonly sessionMeta: TurnSessionMeta;
  readonly sessionContext: SessionContextSnapshot | undefined;
  readonly refreshSessionContext: () => Promise<
    SessionContextSnapshot | undefined
  >;
}): Promise<MarkPreGameCompletionResult> {
  const {
    activeRuntimes,
    completedResults,
    deps,
    input,
    isPreGamePending,
    preGameRuntimes,
    runtimeTriggerCounts,
    refreshSessionContext,
  } = args;
  let preGameCompleted = args.preGameCompleted;
  let sessionMeta = args.sessionMeta;
  let sessionContext = args.sessionContext;

  if (!isPreGamePending || !deps.store || input.manualTrigger) {
    return {
      allDone: !isPreGamePending,
      preGameCompleted,
      sessionMeta,
      sessionContext,
    };
  }

  const newlyDone = collectNewlyDoneRuntimes({
    activeRuntimes,
    completedResults,
    preGameCompleted,
    runtimeTriggerCounts,
  });
  const updated =
    newlyDone.length > 0
      ? [...preGameCompleted, ...newlyDone]
      : preGameCompleted;
  const allDone = preGameRuntimes.every((rt) => updated.includes(rt.name));

  if (newlyDone.length > 0) {
    preGameCompleted = updated;
    await deps.store.updateSession(input.sessionId, {
      preGameCompleted: updated,
      // The `turnCount:1` write is the atomic 0→1 band signal: setting it in the
      // SAME updateSession as `preGameCompleted` avoids a transient state where
      // setup is complete but the counter still reads 0. It is NOT the sole
      // turnCount owner — `advanceSessionTurnCount` (apps/server/.../turn-count.ts)
      // owns main-loop increments, and it deliberately skips the request that
      // completes Pre-Game because this write already accounts for it.
      ...(allDone ? { turnCount: 1 } : {}),
      updatedAt: new Date().toISOString(),
    });
    const refreshedCharacters = await deps.store.listCharacters(
      input.sessionId,
    );
    sessionMeta = {
      ...sessionMeta,
      preGameCompleted,
      characters: refreshedCharacters.map((c) => ({
        name: c.name,
        type: c.type,
        description: c.description,
        fields: c.fields as Record<string, unknown>,
      })),
    };
    sessionContext = await refreshSessionContext();
  }

  return { allDone, preGameCompleted, sessionMeta, sessionContext };
}

function collectNewlyDoneRuntimes(args: {
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly preGameCompleted: readonly string[];
  readonly runtimeTriggerCounts: ReadonlyMap<string, number>;
}): string[] {
  const {
    activeRuntimes,
    completedResults,
    preGameCompleted,
    runtimeTriggerCounts,
  } = args;
  const newlyDone: string[] = [];

  for (const [name, result] of completedResults) {
    if (preGameCompleted.includes(name)) continue;
    const output = result.output as Record<string, unknown> | undefined;
    const preGameDone = output?.preGameDone === true;
    const guardSkipped = result.status === "skipped" && output?.skip === true;
    if (preGameDone || guardSkipped) {
      newlyDone.push(name);
    }
  }

  for (const rt of activeRuntimes) {
    if (!isPreGamePriority(getRuntimeSpec(rt).legacyOrder)) continue;
    if (preGameCompleted.includes(rt.name)) continue;
    if (newlyDone.includes(rt.name)) continue;
    const max = rt.trigger?.maxTriggerCount;
    if (max !== undefined && (runtimeTriggerCounts.get(rt.name) ?? 0) >= max) {
      newlyDone.push(rt.name);
    }
  }

  return newlyDone;
}
