/**
 * Turn / runtime execution record types (PR-1 translation layer included).
 *
 * Split out of `../types.ts` by domain; re-exported there for compatibility.
 */

export interface TurnResultRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeResults: unknown; // JSON — RuntimeResult[]
  readonly conflicts?: unknown; // JSON — WriteConflict[]
  readonly auditResult?: unknown; // JSON — RuntimeResult
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface RuntimeResultRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly status: string;
  readonly output: unknown; // JSON
  readonly toolCalls: unknown; // JSON — ToolCallRecord[]
  readonly durationMs: number;
  readonly tokenUsage?: unknown; // JSON — { input, output }
  readonly error?: string;
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

// ── Translation layer: RuntimeOutput + InteractionRecord (PR-1) ──

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
  /** Optional FK back to `runtime_results.id`. */
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
}

export interface InteractionRecordFilters {
  readonly type?: string;
  readonly source?: string;
  readonly targetPluginId?: string;
  readonly limit?: number;
}
