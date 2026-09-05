import type {
  ActionRequest,
  RuntimeManifest,
  RuntimeResult,
  RuntimeRetryScope,
} from "@covel/shared";
import type { DataStore, TraceEventRecord } from "@covel/store";

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

function readScope(event: TraceEventRecord): RuntimeRetryScope | undefined {
  if (event.type !== "turn.started") return;
  const payload = event.payload as Record<string, unknown> | null;
  const action = payload?.recoveryAction as RuntimeRetryAction | undefined;
  const sourceTurnId =
    typeof payload?.sourceTurnId === "string"
      ? payload.sourceTurnId
      : action?.payload?.retryFromTurnId;
  const runtimeIds = Array.isArray(payload?.runtimeIds)
    ? payload.runtimeIds
    : action?.type === "retry_runtime"
      ? [action.payload.runtimeId]
      : action?.type === "retry_failed_runtimes"
        ? action.payload.runtimeIds
        : [];
  if (
    typeof sourceTurnId !== "string" ||
    !runtimeIds?.length ||
    !runtimeIds.every((id) => typeof id === "string")
  )
    return;
  return { sourceTurnId, runtimeIds };
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
  const rows = await store.listTurnResults(sessionId);
  const requestedSource = action.payload.retryFromTurnId;
  const source = requestedSource
    ? rows.find((row) => row.turnId === requestedSource)
    : [...rows]
        .reverse()
        .find(
          (row) => row.origin === "player" && row.commitStatus === "committed",
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
  if (
    requestedSource &&
    rows
      .slice(rows.indexOf(source) + 1)
      .some(
        (row) =>
          row.commitStatus === "committed" &&
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
  const traces = await store.listTraceEvents(sessionId);
  const scopes = new Map(
    traces.flatMap((event) => {
      const scope = readScope(event);
      return scope ? [[event.turnId, scope] as const] : [];
    }),
  );
  // The public source is always the original committed turn, never an attempt
  // whose partial products could omit successful siblings and the story.
  if (requestedSource && scopes.has(source.turnId)) {
    throw new Error(
      "Use the original source turn when retrying failed runtimes.",
    );
  }
  // listTurnResults is oldest-first. Only a committed attempt can supersede
  // source state: a successful runtime whose transaction rolled back is not healed.
  for (const row of rows) {
    const scope = scopes.get(row.turnId);
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
        result.status === "success" && !runtimeIds.includes(result.runtimeId),
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
