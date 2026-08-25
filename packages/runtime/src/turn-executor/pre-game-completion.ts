import type {
  RuntimeManifest,
  RuntimeResult,
  SetupRuntimeState,
} from "@covel/shared";
import {
  isSetupDoneForVersion,
  mirrorSetupDone,
  resolveSetupGeneration,
} from "@covel/shared";

export interface MarkPreGameCompletionResult {
  readonly allDone: boolean;
  /** Setup mirrors produced for the first time by this execution. */
  readonly newlyDone: Readonly<Record<string, SetupRuntimeState>>;
}

/**
 * Project explicit setup completion signals into the authoritative setup
 * mirror. Persistence remains the finalizer's responsibility so completion
 * and proposal writes commit atomically.
 */
export function markPreGameCompletion(args: {
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly isPreGamePending: boolean;
  readonly isManualTrigger: boolean;
  readonly preGameRuntimes: readonly RuntimeManifest[];
  readonly setupRuntimes: Readonly<Record<string, SetupRuntimeState>>;
}): MarkPreGameCompletionResult {
  const {
    completedResults,
    isPreGamePending,
    isManualTrigger,
    preGameRuntimes,
    setupRuntimes,
  } = args;
  if (!isPreGamePending || isManualTrigger) {
    return { allDone: !isPreGamePending, newlyDone: {} };
  }

  const now = new Date().toISOString();
  const newlyDone: Record<string, SetupRuntimeState> = {};
  for (const runtime of preGameRuntimes) {
    if (isSetupDoneForVersion(setupRuntimes[runtime.name], runtime.version)) {
      continue;
    }
    const result = completedResults.get(runtime.name);
    if (result && setupResultIsDone(result)) {
      const previous = setupRuntimes[runtime.name];
      const generation = resolveSetupGeneration(runtime.version, previous);
      newlyDone[runtime.name] = mirrorSetupDone(
        runtime.version ?? "0.0.0",
        now,
        generation,
        previous?.generation === generation ? previous.attempts + 1 : 1,
      );
    }
  }

  const updated = { ...setupRuntimes, ...newlyDone };
  const allDone = preGameRuntimes.every((runtime) =>
    isSetupDoneForVersion(updated[runtime.name], runtime.version),
  );
  return { allDone, newlyDone };
}

/** A setup runtime completes only through an explicit framework signal. */
function setupResultIsDone(result: RuntimeResult): boolean {
  const output = result.output as Record<string, unknown> | undefined;
  return (
    (result.status === "success" && output?.preGameDone === true) ||
    (result.status === "skipped" && output?.skip === true)
  );
}
