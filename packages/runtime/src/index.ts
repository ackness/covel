// ── Trigger Router ───────────────────────────────────────────────
export { shouldTrigger } from "./trigger/trigger.js";

// ── Scheduler ────────────────────────────────────────────────────
export { scheduleByPriority } from "./schedule/scheduler.js";
export { scheduleByDag } from "./schedule/dag-scheduler.js";

// ── Context Builder (re-exported from @covel/context) ───────────
export {
  interpolateTemplate,
  buildInjectBlocks,
  buildContext,
} from "@covel/context";

// ── Parallel Executor ────────────────────────────────────────────
export { executeParallel } from "./schedule/parallel-executor.js";
export type { RuntimeExecuteFn } from "./schedule/parallel-executor.js";

// ── Turn Executor ────────────────────────────────────────────────
export {
  executeTurn,
  resumeSuspendedRuntime,
} from "./turn-executor/turn-executor.js";
export type {
  AgentLoopDeps,
  TurnExecutorDeps,
  TurnExecutorOptions,
  ResumeSuspendedRuntimeOptions,
} from "./turn-executor/turn-executor.js";
export { createRuntimeMediaContext } from "./function-runtime/runtime-media-context.js";
export type { MediaStoreLike } from "./function-runtime/runtime-media-context.js";

// ── LLM Adapter ─────────────────────────────────────────────────
export type {
  LLMAdapter,
  LLMMessage as LLMAdapterMessage,
  LLMResponse,
  LLMStreamEvent,
  LLMToolCall,
  LLMToolDefinition,
} from "./llm/llm-adapter.js";

// ── Tool Executor ────────────────────────────────────────────────
export { createToolExecutor } from "./agent-loop/tool-executor.js";
export type {
  ToolExecutor,
  ToolInfo,
  ToolCall,
  ToolCallContext,
  ToolCallResult,
  ToolExecutorConfig,
} from "./agent-loop/tool-executor.js";

// ── Model Resolver ──────────────────────────────────────────────
export { createModelResolver } from "./llm/model-resolver.js";

// ── Per-Session Runtime Slot Resolver (PR-6) ───────────────────
export { resolveRuntimeSlot } from "./llm/runtime-slot-resolver.js";

// ── Plugin RPC (PR-3) ──────────────────────────────────────────
export { createPluginRpcRegistry } from "./rpc/rpc-registry.js";
export type {
  PluginRpcRegistry,
  RpcHandler,
  RpcHandlerContext,
  RpcRegistryEntry,
} from "./rpc/rpc-registry.js";
export { createRpcExecutor, RpcDispatchError } from "./rpc/rpc-executor.js";
export type {
  RpcExecutor,
  RpcDispatchRequest,
  RpcDispatchResult,
  RpcDispatchDeps,
} from "./rpc/rpc-executor.js";
export {
  submitFormHandler,
  RpcValidationError,
} from "./rpc-defaults/submit-form.js";

// ── Gateway Bridge ──────────────────────────────────────────────
export { createGatewayAdapter } from "./llm/gateway-llm-adapter.js";
export type {
  GatewayLike,
  GatewayAdapterConfig,
} from "./llm/gateway-llm-adapter.js";

// ── Plugin-facing Gateway Facade (function runtimes) ───────────
export { createPluginRuntimeGateway } from "./function-runtime/plugin-runtime-gateway.js";
export type {
  FullGatewayLike,
  PluginRuntimeGatewayConfig,
} from "./function-runtime/plugin-runtime-gateway.js";
export { withGatewayTrace } from "./function-runtime/gateway-trace.js";
export type { GatewayTraceContext } from "./function-runtime/gateway-trace.js";

// ── Session Kernel ──────────────────────────────────────────────
export {
  normalizeOutput,
  createCommitPipeline,
  processRuntimeResult,
  createTraceRecorder,
} from "./session/session-kernel.js";
export type {
  KernelStore,
  CommitPipeline,
  TraceRecorder,
  ProcessRuntimeResultOutput,
} from "./session/session-kernel.js";

// ── Snapshot Builder ────────────────────────────────────────────
export { buildSessionSnapshot } from "./snapshot/snapshot-builder.js";
export type { SnapshotStore } from "./snapshot/snapshot-builder.js";

// ── Snapshot Payload Builder (S4-T2) ────────────────────────────
export { buildSnapshotPayload } from "./snapshot/snapshot-payload-builder.js";

// ── Types ────────────────────────────────────────────────────────
export type { TriggerContext, ScheduledGroup } from "./types.js";

// Re-export context types for backward compatibility
export type {
  AssembledContext,
  ContextBuildParams,
  LLMMessage,
} from "@covel/context";

// ── Prompt Delta (PR-1 translation layer) ──────────────────────
export { computePromptDelta, applyPromptDelta } from "./llm/prompt-delta.js";
export type { PromptMessage } from "./llm/prompt-delta.js";

// ── Hook Pipeline ────────────────────────────────────────────────
export {
  HookPipeline,
  createHookPipeline,
  registerPluginHooks,
  runSessionStartHook,
  runSessionEndHook,
  runWithHookScope,
} from "./hooks/index.js";
export type { SessionStartPayload, SessionEndPayload } from "./hooks/index.js";
export { HOOK_SEMANTICS } from "./hooks/index.js";
export type {
  PluginHookSource,
  RegisterPluginHooksOptions,
} from "./hooks/index.js";
export type {
  HookEvent,
  HookSemantic,
  HookEnforce,
  HookContext,
  HookResult,
  HookHandler,
  HookRegistration,
  HookDeclaration,
} from "./hooks/index.js";

// ── Turn Emitter (per-turn trace fan-out) ───────────────────────
export {
  createTurnEmitter,
  createNoopTurnEmitter,
} from "./trace/turn-emitter.js";
export type {
  TurnEmitter,
  TurnEmitterStore,
  CreateTurnEmitterOptions,
} from "./trace/turn-emitter.js";

// ── Function-runtime handler helpers ────────────────────────────
export {
  createPluginDataWriter,
  createPluginLogger,
  createFunctionStoreView,
  createRpcHandlerStoreView,
} from "./function-runtime/plugin-handler-helpers.js";
export type { HandlerHelperContext } from "./function-runtime/plugin-handler-helpers.js";
