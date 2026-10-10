export { enforcePluginRegistrationContract } from "./plugin-registration-contract.js";
export { PluginServiceRegistry } from "./plugin-services.js";
export {
  PluginExtensionHost,
  kernelExtensionPoints,
} from "./plugin-extensions.js";
export type {
  PluginExtensionExecution,
  PluginExtensionExecutionScope,
} from "./plugin-extensions.js";
export { createExtensionRegistration } from "./plugin-extension-registration.js";
export {
  createWorldModelView,
  overlayWorldModelView,
  collectUpstreamWorldProposals,
} from "./function-runtime/world-model-view.js";
// ── Trigger Router ───────────────────────────────────────────────
export { shouldTrigger } from "./trigger/trigger.js";

// ── Scheduler ────────────────────────────────────────────────────
export { scheduleByDag } from "./schedule/dag-scheduler.js";
export {
  createDetachedProposalGuard,
  planTurnDetachment,
} from "./schedule/turn-completion.js";
export type {
  TurnDetachmentDiagnostic,
  TurnDetachmentPlan,
} from "./schedule/turn-completion.js";

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

export {
  buildHookSettings,
  snapshotUserSettings,
} from "./hooks/hook-settings.js";

// ── Turn Executor ────────────────────────────────────────────────
export { executeTurn, resumeSuspendedRuntime } from "./execution.js";
export type {
  PreparedExecution,
  ExecutedTurn,
  ExecutedRuntime,
  ExecutionDeps,
  ExecutionCommitPlan,
} from "./execution.js";
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
  LLMTargetIdentity,
  LLMMessage as LLMAdapterMessage,
  LLMUsageSummary,
  LLMResponse,
  LLMStreamEvent,
  LLMToolCall,
  LLMToolDefinition,
} from "./llm/llm-adapter.js";

// ── Tool Executor ────────────────────────────────────────────────
export { createToolExecutor } from "./agent-loop/tool-executor.js";
export type {
  ToolExecutor,
  ManagedToolExecutor,
  ToolInfo,
  ToolCall,
  ToolCallContext,
  ToolCallResult,
  ToolExecutorConfig,
} from "./agent-loop/tool-executor.js";

// ── Model Resolver ──────────────────────────────────────────────
export type { PluginLlmModelTarget } from "./llm/model-resolver.js";
export { createModelResolver } from "./llm/model-resolver.js";

// ── Per-Session Runtime Slot Resolver ───────────────────

// ── Public Plugin API (unified `entry` module contract) ────────
export type {
  PluginAPI,
  PluginEntryFactory,
  PluginHookOptions,
  PluginRpcOptions,
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
  createSubmitFormHandler,
  findCommittedInteraction,
  FormRejectedError,
  InteractionAlreadySubmittedError,
  RpcValidationError,
} from "./rpc-defaults/submit-form.js";

// ── Gateway Bridge ──────────────────────────────────────────────
export {
  createGatewayAdapter,
  resolveGatewayModelSelection,
} from "./llm/gateway-llm-adapter.js";
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
export { commitExecution } from "./commit/commit-execution.js";
export type {
  CommitExecutionArgs,
  CommitExecutionOutcome,
  ExecutionCompletion,
} from "./commit/commit-execution.js";
export {
  applyIsolatedRuntimes,
  finalizeExecution,
} from "./commit/finalize-execution.js";
export { updateSetupRuntimeStates } from "./commit/session-clock.js";
export {
  droppedEmitter,
  droppedUpstream,
  settleDroppedInputs,
} from "./commit/commit-dependencies.js";
export { normalizeHandlerResult } from "./commit/normalize-handler-result.js";
export { materializeHandlerSuccess } from "./commit/materialize-handler-output.js";
export type {
  CommitIsolation,
  FinalizeExecutionArgs,
  FinalizeExecutionOutcome,
  IsolatedRuntime,
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

// ── Hook Pipeline ────────────────────────────────────────────────
export {
  HookPipeline,
  createHookPipeline,
  runSessionStartHook,
  runSessionEndHook,
  runWithHookScope,
} from "./hooks/index.js";
export type {
  HookScope,
  SessionStartPayload,
  SessionEndPayload,
} from "./hooks/index.js";
export { HOOK_SEMANTICS } from "./hooks/index.js";
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
export type {
  HandlerHelperContext,
  TrustedHandlerStore,
} from "./function-runtime/plugin-handler-helpers.js";
export {
  createPluginRandom,
  restartSessionRandom,
} from "./function-runtime/plugin-random.js";

export { resolveRequestContextBudget } from "./agent-loop/request-context-budget.js";
export type {
  FormIssue,
  FormValidator,
  ValidatePluginForm,
} from "./rpc/form-validator.js";
export { normalizeFormRefusal } from "./rpc/form-validator.js";
export { PluginEntryScope } from "./plugin-entry-scope.js";
export type { PluginServiceCallEvent } from "./plugin-services.js";

export { validatePluginHookRegistration } from "./plugin-hook-registration.js";
