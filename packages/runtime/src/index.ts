// ── Trigger Router ───────────────────────────────────────────────
export { shouldTrigger } from "./trigger/trigger.js";

// ── Scheduler ────────────────────────────────────────────────────
export {
  scheduleByDag,
  deriveConservativeSetupEdges,
} from "./schedule/dag-scheduler.js";

// ── Effects hazard (same-layer read/write policy) ────────────────
export {
  deriveEffects,
  resourcesIntersect,
  effectsHazard,
  applyHazardPolicy,
  resolveEffectsPolicy,
} from "./schedule/effects.js";
export type {
  RuntimeEffects,
  EffectsPolicy,
  HazardPolicyResult,
} from "./schedule/effects.js";

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
export {
  PLAYER_ABORT_REASON,
  TurnAbortedError,
  isTurnAbortedError,
} from "./turn-executor/turn-control.js";
export type { TurnControl } from "./turn-executor/turn-control.js";
export { createRuntimeMediaContext } from "./function-runtime/runtime-media-context.js";
export type { MediaStoreLike } from "./function-runtime/runtime-media-context.js";

// ── MediaRef canonicalization (shared boundary scanner) ─────────
export { canonicalizeMediaRefs } from "./media/canonicalize-media-refs.js";
export type {
  MediaOwnershipStore,
  MediaCanonicalization,
  MediaRejection,
  MediaRejectionReason,
  MediaDiagnostic,
} from "./media/canonicalize-media-refs.js";

// ── Job status (kernel-owned, append-only progress channel) ─────
export {
  createProgressReporter,
  finalizeJobStatuses,
} from "./job-status/job-status.js";
export type {
  ProgressReporterDeps,
  ExecutionJobOutcome,
} from "./job-status/job-status.js";

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

// ── Per-Session Runtime Slot Resolver ───────────────────
export { resolveRuntimeSlot } from "./llm/runtime-slot-resolver.js";

// ── Public Plugin API (unified `entry` module contract) ────────
export type {
  PluginAPI,
  PluginEntryFactory,
  PluginHookOptions,
  PluginRpcOptions,
  PluginStoreView,
  PluginToolkit,
} from "./plugin-api.js";

// ── Plugin RPC ──────────────────────────────────────────
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
export { finalizeExecution } from "./commit/finalize-execution.js";
export type {
  FinalizeExecutionArgs,
  FinalizeExecutionOutcome,
} from "./commit/finalize-execution.js";

// ── Snapshot Builder ────────────────────────────────────────────
export { buildSessionSnapshot } from "./snapshot/snapshot-builder.js";
export type { SnapshotStore } from "./snapshot/snapshot-builder.js";

// ── Snapshot Payload Builder ────────────────────────────
export { buildSnapshotPayload } from "./snapshot/snapshot-payload-builder.js";
export {
  DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS,
  saveAutoSnapshot,
} from "./snapshot/auto-snapshot.js";
export type { SaveAutoSnapshotOptions } from "./snapshot/auto-snapshot.js";

// ── Types ────────────────────────────────────────────────────────
export type { TriggerContext, ScheduledGroup } from "./types.js";

// ── Prompt Delta (translation layer) ──────────────────────
export { computePromptDelta, applyPromptDelta } from "./llm/prompt-delta.js";
export type { PromptMessage } from "./llm/prompt-delta.js";

// ── Hook Pipeline ────────────────────────────────────────────────
export {
  HookPipeline,
  createHookPipeline,
  registerPluginHooks,
  activateDeferredPluginHooks,
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
  createTrustedHandlerStore,
} from "./function-runtime/plugin-handler-helpers.js";
export type { HandlerHelperContext } from "./function-runtime/plugin-handler-helpers.js";
