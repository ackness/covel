// ── Trigger Router ───────────────────────────────────────────────
export { shouldTrigger } from './trigger.js';

// ── Scheduler ────────────────────────────────────────────────────
export { scheduleByPriority } from './scheduler.js';

// ── Context Builder (re-exported from @covel/context) ───────────
export { interpolateTemplate, buildInjectBlocks, buildContext } from '@covel/context';

// ── Parallel Executor ────────────────────────────────────────────
export { executeParallel, resolveFailure } from './parallel-executor.js';
export type { RuntimeExecuteFn, FailureResolution } from './parallel-executor.js';

// ── Turn Executor ────────────────────────────────────────────────
export { executeTurn } from './turn-executor.js';
export type { TurnExecutorDeps, TurnExecutorOptions } from './turn-executor.js';

// ── LLM Adapter ─────────────────────────────────────────────────
export type { LLMAdapter, LLMMessage as LLMAdapterMessage, LLMResponse, LLMStreamEvent, LLMToolCall, LLMToolDefinition } from './llm-adapter.js';

// ── Tool Executor ────────────────────────────────────────────────
export { createToolExecutor } from './tool-executor.js';
export type { ToolExecutor, ToolInfo, ToolCall, ToolCallContext, ToolCallResult, ToolExecutorConfig } from './tool-executor.js';

// ── Model Resolver ──────────────────────────────────────────────
export { createModelResolver } from './model-resolver.js';

// ── Gateway Bridge ──────────────────────────────────────────────
export { createGatewayAdapter } from './gateway-llm-adapter.js';
export type { GatewayLike, GatewayAdapterConfig } from './gateway-llm-adapter.js';

// ── Session Kernel ──────────────────────────────────────────────
export { normalizeOutput, createCommitPipeline, processRuntimeResult, createTraceRecorder } from './session-kernel.js';
export type { KernelStore, CommitPipeline, TraceRecorder } from './session-kernel.js';

// ── Snapshot Builder ────────────────────────────────────────────
export { buildSessionSnapshot } from './snapshot-builder.js';
export type { SnapshotStore } from './snapshot-builder.js';

// ── Types ────────────────────────────────────────────────────────
export type {
  TriggerContext,
  ScheduledGroup,
} from './types.js';

// Re-export context types for backward compatibility
export type { AssembledContext, ContextBuildParams, LLMMessage } from '@covel/context';
