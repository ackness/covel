import type { TurnCache, TurnState, CachedRuntimeResult, KernelExecuteOptions, DEFAULT_RUNTIME_PRIORITY } from "./types.js";
import { deepMerge } from "./commit/commit-service.js";

/**
 * Resolve the retry-from priority given a target runtime ID and the last turn cache.
 *
 * Returns `null` if no target was specified or the target was not found in cache
 * (in which case the entire turn should re-execute).
 */
export function resolveRetryFromPriority(
  retryFromRuntimeId: string | undefined,
  lastTurnCache: TurnCache | null,
): number | null {
  if (!retryFromRuntimeId || !lastTurnCache) return null;

  const cachedTarget = lastTurnCache.runtimeResults.find(
    (r) => r.runtimeId === retryFromRuntimeId,
  );
  return cachedTarget?.priority ?? null;
}

/**
 * Build the merged options for a retry execution.
 *
 * Merges the cached API keys / slot overrides from the previous turn with any
 * caller-supplied overrides (caller wins), then sets `retryFromRuntimeId`.
 */
export function buildRetryOptions(
  fromRuntimeId: string | undefined,
  callerOptions: KernelExecuteOptions,
  cache: TurnCache,
): KernelExecuteOptions {
  return {
    ...callerOptions,
    apiKeys: callerOptions.apiKeys ?? cache.apiKeys,
    slotOverrides: callerOptions.slotOverrides ?? cache.slotOverrides,
    retryFromRuntimeId: fromRuntimeId,
  };
}

/**
 * Apply a list of cached proposals to `turnState` using the same merge semantics
 * as the live execution path (deepMerge for state.patch).
 *
 * Used when replaying cached runtime results during a partial retry.
 */
export function applyCachedProposals(
  turnState: TurnState,
  proposals: CachedRuntimeResult["proposals"],
): void {
  for (const item of proposals) {
    switch (item.kind) {
      case "narrative.append": {
        const p = item.payload as { text: string };
        turnState.narrativeSegments.push(p.text);
        break;
      }
      case "state.patch": {
        turnState.state = deepMerge(
          turnState.state,
          item.payload as Record<string, unknown>,
        );
        break;
      }
      case "record.upsert": {
        const r = item.payload as { key: string; value: unknown };
        turnState.records.set(r.key, r.value);
        break;
      }
    }
  }
}
