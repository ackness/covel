import type {
  RuntimeManifest,
  RuntimeResult,
  SetupRuntimeState,
  TurnInput,
} from "@covel/shared";
import { getRuntimeSpec, mirrorSetupDone } from "@covel/shared";
import type { SessionContextSnapshot } from "@covel/context";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
import type { TurnSessionMeta } from "./session-state.js";
import { isPreGamePriority } from "../schedule/scheduler.js";

export interface MarkPreGameCompletionResult {
  readonly allDone: boolean;
  readonly preGameCompleted: readonly string[];
  readonly sessionMeta: TurnSessionMeta;
  readonly sessionContext: SessionContextSnapshot | undefined;
  /**
   * Setup runtimes that reported done for the FIRST time in this call, mirrored
   * as `SetupRuntimeState`. The turn executor accumulates these across the
   * pass(es) it makes and hands them to the finalizer, which folds them into
   * the session-clock write (setup mirror + phase flip) inside the commit
   * transaction. Empty when nothing newly completed.
   */
  readonly newlyDone: Readonly<Record<string, SetupRuntimeState>>;
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
      newlyDone: {},
    };
  }

  const newlyDoneNames = collectNewlyDoneRuntimes({
    activeRuntimes,
    completedResults,
    preGameCompleted,
    runtimeTriggerCounts,
  });
  const updated =
    newlyDoneNames.length > 0
      ? [...preGameCompleted, ...newlyDoneNames]
      : preGameCompleted;
  const allDone = preGameRuntimes.every((rt) => updated.includes(rt.name));

  let newlyDone: Record<string, SetupRuntimeState> = {};
  if (newlyDoneNames.length > 0) {
    preGameCompleted = updated;
    // Mirror each newly-done setup runtime. The actual persist happens in the
    // finalize transaction (session-clock write) so the phase flip and mirror
    // roll back with a failed commit; here we only advance in-memory state so
    // same-request main-loop follow-ups see setup as complete.
    const now = new Date().toISOString();
    const manifestById = new Map(activeRuntimes.map((rt) => [rt.name, rt]));
    newlyDone = Object.fromEntries(
      newlyDoneNames.map((name) => [
        name,
        mirrorSetupDone(manifestById.get(name)?.version ?? "0.0.0", now),
      ]),
    );

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

  return { allDone, preGameCompleted, sessionMeta, sessionContext, newlyDone };
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
