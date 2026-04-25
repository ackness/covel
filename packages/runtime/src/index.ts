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
export { executeTurn, resumeSuspendedRuntime } from './turn-executor.js';
export type { TurnExecutorDeps, TurnExecutorOptions, ResumeSuspendedRuntimeOptions } from './turn-executor.js';

// ── LLM Adapter ─────────────────────────────────────────────────
export type { LLMAdapter, LLMMessage as LLMAdapterMessage, LLMResponse, LLMStreamEvent, LLMToolCall, LLMToolDefinition } from './llm-adapter.js';

// ── Tool Executor ────────────────────────────────────────────────
export { createToolExecutor } from './tool-executor.js';
export type { ToolExecutor, ToolInfo, ToolCall, ToolCallContext, ToolCallResult, ToolExecutorConfig } from './tool-executor.js';

// ── Model Resolver ──────────────────────────────────────────────
export { createModelResolver } from './model-resolver.js';

// ── Per-Session Runtime Slot Resolver (PR-6) ───────────────────
export { resolveRuntimeSlot } from './runtime-slot-resolver.js';

// ── Plugin RPC (PR-3) ──────────────────────────────────────────
export { createPluginRpcRegistry } from './rpc-registry.js';
export type {
  PluginRpcRegistry,
  RpcHandler,
  RpcHandlerContext,
  RpcRegistryEntry,
} from './rpc-registry.js';
export { createRpcExecutor, RpcDispatchError } from './rpc-executor.js';
export type {
  RpcExecutor,
  RpcDispatchRequest,
  RpcDispatchResult,
  RpcDispatchDeps,
} from './rpc-executor.js';
export { submitFormHandler, RpcValidationError } from './rpc-defaults/submit-form.js';

// ── Gateway Bridge ──────────────────────────────────────────────
export { createGatewayAdapter } from './gateway-llm-adapter.js';
export type { GatewayLike, GatewayAdapterConfig } from './gateway-llm-adapter.js';

// ── Plugin-facing Gateway Facade (function runtimes) ───────────
export { createPluginRuntimeGateway } from './plugin-runtime-gateway.js';
export type {
  FullGatewayLike,
  PluginRuntimeGatewayConfig,
} from './plugin-runtime-gateway.js';

// ── Session Kernel ──────────────────────────────────────────────
export { normalizeOutput, createCommitPipeline, processRuntimeResult, createTraceRecorder } from './session-kernel.js';
export type { KernelStore, CommitPipeline, TraceRecorder, ProcessRuntimeResultOutput } from './session-kernel.js';

// ── Snapshot Builder ────────────────────────────────────────────
export { buildSessionSnapshot } from './snapshot-builder.js';
export type { SnapshotStore } from './snapshot-builder.js';

// ── Snapshot Payload Builder (S4-T2) ────────────────────────────
export { buildSnapshotPayload } from './snapshot-payload-builder.js';

// ── Types ────────────────────────────────────────────────────────
export type {
  TriggerContext,
  ScheduledGroup,
} from './types.js';

// Re-export context types for backward compatibility
export type { AssembledContext, ContextBuildParams, LLMMessage } from '@covel/context';

// ── Prompt Delta (PR-1 translation layer) ──────────────────────
export { computePromptDelta, applyPromptDelta } from './prompt-delta.js';
export type { PromptMessage } from './prompt-delta.js';

// ── Hook Pipeline ────────────────────────────────────────────────
export { HookPipeline, createHookPipeline, registerPluginHooks } from './hooks/index.js';
export type { PluginHookSource, RegisterPluginHooksOptions } from './hooks/index.js';
export type {
  HookEvent,
  HookContext,
  HookResult,
  HookHandler,
  HookRegistration,
  HookDeclaration,
} from './hooks/index.js';

// ── Turn Emitter (per-turn trace fan-out) ───────────────────────
export { createTurnEmitter, createNoopTurnEmitter } from './turn-emitter.js';
export type { TurnEmitter, TurnEmitterStore, CreateTurnEmitterOptions } from './turn-emitter.js';

// ── Function-runtime handler helpers ────────────────────────────
export {
  createPluginDataWriter,
  createPluginLogger,
  createFunctionStoreView,
} from './plugin-handler-helpers.js';
export type { HandlerHelperContext } from './plugin-handler-helpers.js';
