/**
 * RuntimeOutput — unified translation-layer record for one runtime execution.
 *
 * Written once per runtime run (both agent and function). Consumers include:
 *   - Downstream runtimes (read `results[].text` as context snippet)
 *   - Frontends (read `results[].structured` for custom widgets)
 *   - Observability systems (meta_data carries prompt delta, tool trail)
 *
 * Paired with `trace_events` which remains the low-level debug timeline.
 * RuntimeOutput is the normalized layer — trace_events is the raw layer.
 */

import type { TokenUsage } from './execution.js';

// ── Leaf types ────────────────────────────────────────────────────

/**
 * One "result entry" produced by a runtime.
 *
 * A runtime may emit multiple entries (e.g. a weather runtime could emit
 * one per city), or a single entry summarizing its output.
 */
export interface RuntimeOutputResult {
  /** Natural-language summary — read by downstream LLM runtimes. */
  readonly text: string;
  /**
   * Plugin-defined structured payload — read by frontend widgets,
   * downstream function runtimes, or tool chains. Opaque to the framework.
   */
  readonly structured?: unknown;
}

/**
 * Structured record of one tool invocation inside the runtime.
 * Mirrors `ToolCallRecord` but lives alongside the runtime output so that
 * consumers can replay the tool trail without a separate query.
 */
export interface RuntimeOutputToolCall {
  readonly tool: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly status: 'success' | 'error';
  readonly durationMs: number;
}

/**
 * One message in the prompt delta.
 * Matches the OpenAI/Anthropic-style chat turn shape, stripped of
 * provider-specific fields.
 */
export interface RuntimeOutputPromptMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
}

// ── Metadata ─────────────────────────────────────────────────────

export interface RuntimeOutputMetaData {
  /** Global 0-based turnNumber (counts all player messages). */
  readonly turn: number;
  /**
   * Playing-phase turn counter. Set once PR-2 ships. Optional for now
   * so pre-PR-2 writers stay valid.
   */
  readonly playingTurn?: number;
  /** Session phase at the time this record was written. */
  readonly phase: string;
  /**
   * Prompt delta relative to the previous call of the same runtime in
   * the same turn. First call has delta = full prompt (or null for
   * function runtimes). Full prompt reconstruction happens server-side
   * via `/runtime-outputs/:id/full-prompt`.
   */
  readonly rawPromptDelta?: readonly RuntimeOutputPromptMessage[];
  /**
   * Raw LLM responses (streaming events merged into final text), one
   * per assistant turn in the tool loop. Undefined for function runtimes.
   */
  readonly outputResponses?: readonly string[];
  /** Tool calls invoked during this runtime execution, in order. */
  readonly toolCallList?: readonly RuntimeOutputToolCall[];
  /** Slot name actually used to dispatch the LLM request. */
  readonly modelSlot?: string;
  /** Token usage for the entire runtime invocation (all tool loop steps). */
  readonly tokenUsage?: TokenUsage;
}

// ── Top-level record ──────────────────────────────────────────────

export interface RuntimeOutput {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Optional back-reference to the `runtime_results` row this output corresponds to. */
  readonly runtimeResultId?: string;
  readonly pluginId: string;
  /** Full runtime id in `{plugin}/{runtime}` form (or `{plugin}` for single-runtime plugins). */
  readonly runtimeId: string;
  readonly timestamp: string; // ISO 8601
  readonly results: readonly RuntimeOutputResult[];
  readonly metaData: RuntimeOutputMetaData;
}
