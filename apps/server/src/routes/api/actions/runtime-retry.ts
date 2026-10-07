import type {
  ActionRequest,
  RuntimeManifest,
  RuntimeResult,
  RuntimeRetryScope,
} from "@covel/shared";
import type { DataStore } from "@covel/store";

type RuntimeRetryAction = Extract<
  ActionRequest,
  {
    type: "retry_runtime" | "retry_failed_runtimes";
  }
>;

export interface RuntimeRetryPlan {
  readonly scope?: RuntimeRetryScope;
  readonly seedResults: readonly RuntimeResult[];
  readonly sourceRuntimeIds: readonly string[];
}

/** Called under the session lock, before any execution or preparation writes. */
export async function prepareRuntimeRetry(
  store: DataStore,
  sessionId: string,
  action: RuntimeRetryAction,
  activeRuntimes: readonly RuntimeManifest[],
): Promise<RuntimeRetryPlan> {
  const runtimeIds =
    action.type === "retry_runtime"
      ? [action.payload.runtimeId]
      : action.payload.runtimeIds;
  const requestedSource = action.payload.retryFromTurnId;
  const [source] = await store.queryTurnResults(
    sessionId,
    requestedSource
      ? { turnId: requestedSource, limit: 1 }
      : {
          origins: ["player"],
          commitStatus: "committed",
          newestFirst: true,
          limit: 1,
        },
  );
  if (!source) {
    // Preserve unseeded manual calls only when no explicit source was supplied.
    if (action.type === "retry_runtime" && !requestedSource)
      return { seedResults: [], sourceRuntimeIds: [] };
    throw new Error("The retry source turn was not found in this session.");
  }
  if (source.commitStatus !== "committed") {
    throw new Error(
      "The retry source turn has not committed. Recover the original action first.",
    );
  }
  if (
    runtimeIds.some(
      (id) => !activeRuntimes.some((runtime) => runtime.name === id),
    )
  ) {
    throw new Error("A retry target is no longer active in this session.");
  }
  const rows = await store.queryTurnResults(sessionId, {
    since: source.createdAt,
    commitStatus: "committed",
  });
  if (
    requestedSource &&
    rows
      .slice(rows.findIndex((row) => row.id === source.id) + 1)
      .some(
        (row) =>
          row.turnId !== source.turnId &&
          (row.origin === "player" || row.origin === "continuation"),
      )
  ) {
    throw new Error(
      "The story has advanced beyond this retry source. Refresh the task statuses before retrying.",
    );
  }
  const sourceResults = Array.isArray(source.runtimeResults)
    ? (source.runtimeResults as RuntimeResult[])
    : [];
  const results = new Map(
    sourceResults.map((result) => [result.runtimeId, result]),
  );
  // The public source is always the original committed turn, never an attempt
  // whose partial products could omit successful siblings and the story.
  if (requestedSource && source.retryScope) {
    throw new Error(
      "Use the original source turn when retrying failed runtimes.",
    );
  }
  // Attempts are oldest-first. Only a committed attempt can supersede
  // source state: a successful runtime whose transaction rolled back is not healed.
  for (const row of rows) {
    const scope = row.retryScope;
    if (
      row.commitStatus !== "committed" ||
      scope?.sourceTurnId !== source.turnId
    )
      continue;
    for (const result of (Array.isArray(row.runtimeResults)
      ? row.runtimeResults
      : []) as RuntimeResult[]) {
      if (
        scope.runtimeIds.includes(result.runtimeId) &&
        results.has(result.runtimeId) &&
        (result.status === "success" || result.status === "failed")
      ) {
        results.set(result.runtimeId, result);
      }
    }
  }
  if (
    requestedSource &&
    runtimeIds.some((id) => results.get(id)?.status !== "failed")
  ) {
    throw new Error(
      "A retry target is no longer failed. Refresh the task statuses before retrying.",
    );
  }
  return {
    sourceRuntimeIds: [...results.keys()],
    scope: {
      sourceTurnId: source.turnId,
      runtimeIds,
      sourceCommitted: true,
      sourceFailedRuntimeIds: [...results.values()]
        .filter((result) => result.status === "failed")
        .map((result) => result.runtimeId)
        .sort(),
    },
    seedResults: [...results.values()].filter(
      (result) =>
        (result.status === "success" ||
          (result.status === "skipped" && result.output?.skip === true)) &&
        !runtimeIds.includes(result.runtimeId),
    ),
  };
}

/** Runtime success only changes the durable failure ledger after commit. */
export function settleRuntimeRetry(
  plan: RuntimeRetryPlan | undefined,
  results: readonly RuntimeResult[],
  committed: boolean,
): RuntimeRetryScope | undefined {
  const scope = plan?.scope;
  if (!scope?.sourceFailedRuntimeIds || !committed) return scope;
  const failed = new Set(scope.sourceFailedRuntimeIds);
  for (const result of results) {
    if (
      !scope.runtimeIds.includes(result.runtimeId) ||
      !plan?.sourceRuntimeIds.includes(result.runtimeId)
    )
      continue;
    if (result.status === "success") failed.delete(result.runtimeId);
    else if (result.status === "failed") failed.add(result.runtimeId);
  }
  return { ...scope, sourceFailedRuntimeIds: [...failed].sort() };
}
