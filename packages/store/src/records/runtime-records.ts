/** Turn / runtime execution record types (translation layer included). */

import type { ExecutionOrigin, OperationSettlement } from "@covel/shared";

/** A runtime whose recorded result is settled as failed at commit. */
export interface FailedRuntimeResult {
  readonly runtimeId: string;
  /**
   * The failed run. With it, only the entry of that run settles: the same
   * runtime can also have run nested in the same turn.
   */
  readonly runId?: string;
  readonly error: string;
}

/** `runtimeResults` with each listed runtime's entry settled as failed. */
export function settleFailedRuntimeResults(
  runtimeResults: unknown,
  failed: readonly FailedRuntimeResult[],
): unknown {
  if (failed.length === 0 || !Array.isArray(runtimeResults))
    return runtimeResults;
  const byRun = new Map<string, string>();
  const byRuntime = new Map<string, string>();
  for (const item of failed) {
    if (item.runId !== undefined) byRun.set(item.runId, item.error);
    else byRuntime.set(item.runtimeId, item.error);
  }
  return runtimeResults.map((entry: unknown) => {
    const { runtimeId, runId } =
      entry && typeof entry === "object"
        ? (entry as { runtimeId?: unknown; runId?: unknown })
        : {};
    const error =
      (typeof runId === "string" ? byRun.get(runId) : undefined) ??
      (typeof runtimeId === "string" ? byRuntime.get(runtimeId) : undefined);
    return error !== undefined
      ? { ...(entry as object), status: "failed", error }
      : entry;
  });
}

/**
 * `runtimeResults` with each listed operation record settled, by record id.
 * Every result entry's `operations` list is searched; entries without one
 * are returned unchanged.
 */
export function settleOperationRecords(
  runtimeResults: unknown,
  settled: readonly OperationSettlement[],
): unknown {
  if (settled.length === 0 || !Array.isArray(runtimeResults))
    return runtimeResults;
  const byId = new Map(settled.map((item) => [item.id, item]));
  return runtimeResults.map((entry: unknown) => {
    const operations =
      entry && typeof entry === "object"
        ? (entry as { operations?: unknown }).operations
        : undefined;
    if (!Array.isArray(operations)) return entry;
    let changed = false;
    const next = operations.map((record: unknown) => {
      const id =
        record && typeof record === "object"
          ? (record as { id?: unknown }).id
          : undefined;
      const settlement = typeof id === "string" ? byId.get(id) : undefined;
      if (!settlement) return record;
      changed = true;
      const { reason: _reason, ...rest } = record as Record<string, unknown>;
      return {
        ...rest,
        status: settlement.status,
        ...(settlement.reason !== undefined
          ? { reason: settlement.reason }
          : {}),
      };
    });
    return changed ? { ...(entry as object), operations: next } : entry;
  });
}

export interface TurnResultRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeResults: unknown; // JSON — RuntimeResult[]
  readonly conflicts?: unknown; // JSON — WriteConflict[]
  readonly auditResult?: unknown; // JSON — RuntimeResult
  /**
   * Execution origin: which path produced this
   * execution artifact. `player` = main action turn; `manual` = plugin-rpc
   * manual trigger; `background` = detached runtime; `recursive` = nested
   * ctx.recursiveCall.
   */
  readonly origin: ExecutionOrigin;
  /** Parent turnId for `recursive` executions whose delta overrode turnId. */
  readonly parentTurnId?: string;
  /** Durable retry provenance, independent of diagnostic trace retention. */
  readonly retryScope?: {
    readonly sourceTurnId: string;
    readonly runtimeIds: readonly string[];
  };
  /**
   * Whether this execution's proposals were committed.
   *
   * The row is written BEFORE commit — it is an execution artifact, not proof
   * of committed game state — so a row with no completion is the expected
   * crash signature. Without this field a crash is indistinguishable from a
   * turn whose commit failed, and both look like a successful turn to anyone
   * reading the table. `pending` is the pre-commit state; the commit-owning
   * caller settles it.
   */
  readonly commitStatus: "pending" | "committed" | "failed";
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface ToolCallRecordRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly input: unknown; // JSON
  readonly output: unknown; // JSON
  readonly durationMs: number;
  readonly approvalStatus: string;
  readonly createdAt: string;
}

// ── Translation layer: RuntimeOutput + InteractionRecord ──

/**
 * Normalised record of one runtime execution's output. Written by
 * `turn-executor` after each runtime finishes. Consumers include downstream
 * runtimes (via `results[].text` as context), frontends (via
 * `results[].structured`), and observability tooling (via `metaData`).
 *
 * Paired with `trace_events` — this table is the normalised/consumable layer,
 * `trace_events` remains the low-level debug timeline.
 */
export interface RuntimeOutputRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Run id of the runtime result inside `turn_results.runtimeResults`. */
  readonly runtimeResultId?: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly timestamp: string;
  /** JSON — readonly RuntimeOutputResult[] */
  readonly results: unknown;
  /** JSON — RuntimeOutputMetaData */
  readonly metaData: unknown;
  readonly createdAt: string;
}

/**
 * Normalised record of one external input (player message, plugin UI click,
 * form submit, RPC call, external skill invocation). Complements
 * `RuntimeOutputRecord` — the two together form the complete event stream
 * of a session for observability and replay.
 */
export interface InteractionRecordRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly timestamp: string;
  readonly source: string;
  readonly channel: string;
  readonly type: string;
  readonly targetPluginId?: string;
  readonly targetRuntimeId?: string;
  readonly payload: unknown; // JSON
  readonly metaData?: unknown; // JSON
  readonly createdAt: string;
}

export interface RuntimeOutputFilters {
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly sinceTimestamp?: string;
  readonly limit?: number;
  /**
   * Rows to skip, applied after ordering. Required for offset pagination —
   * callers that page with `{ limit, offset }` would otherwise re-read page 0
   * forever, since a dropped offset still yields a full page every round.
   */
  readonly offset?: number;
}

export interface InteractionRecordFilters {
  readonly type?: string;
  readonly source?: string;
  readonly targetPluginId?: string;
  readonly limit?: number;
}
