// ── Kernel ──────────────────────────────────────────────────────────
export {
  bootstrapKernel,
  createKernel,
  type KernelBootstrapConfig,
  type KernelInstance,
  type KernelSession,
  type Kernel,
  type KernelDeps,
  type KernelContext,
  type CreateSessionOptions,
} from "./kernel.js";

// ── Trust ──────────────────────────────────────────────────────────
export {
  createPermissiveTrustPolicy,
  type TrustPolicy,
  type TrustDecision,
  type RuntimeTrustContext,
  type ToolTrustContext,
  type ProposalTrustContext,
} from "./trust/trust-policy.js";

// ── Types ───────────────────────────────────────────────────────────
export type {
  CandidateRuntime,
  ScheduledRuntime,
  ExecutionPlan,
  TurnState,
  KernelExecuteOptions,
} from "./types.js";

export {
  DEFAULT_RUNTIME_PRIORITY,
  DEFAULT_BACKGROUND_THRESHOLD,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_STEPS_NO_TOOLS,
} from "./types.js";

// ── Router ──────────────────────────────────────────────────────────
export { routeTrigger } from "./router/trigger-router.js";

// ── Scheduler ───────────────────────────────────────────────────────
export { buildExecutionPlan } from "./scheduler/runtime-scheduler.js";

// ── Context ─────────────────────────────────────────────────────────
export { assembleContext, type ContextAssemblyInput } from "./context/context-assembler.js";
export { gatherContextFragments, type ContextFragment } from "./context/context-provider-bridge.js";

// ── Runner ──────────────────────────────────────────────────────────
export { runRuntime, type RuntimeRunnerDeps, type RuntimeRunResult } from "./runner/runtime-runner.js";

// ── Tools ───────────────────────────────────────────────────────────
export { executeTool, type ToolCallRequest, type ToolCallResult } from "./tools/tool-executor.js";
export { createBuiltinDataTools, type BuiltinToolEntry, type BuiltinToolDeps } from "./tools/builtin-data-tools.js";

// ── Data Access ────────────────────────────────────────────────────
export { createPluginDataAccess, type DataAccessSources } from "./data-access/plugin-data-access.js";

// ── Proposals ───────────────────────────────────────────────────────
export { createProposalCollector, type ProposalCollector } from "./proposals/proposal-collector.js";
export { validateProposals, type ValidationResult } from "./proposals/proposal-validator.js";

// ── Commit ──────────────────────────────────────────────────────────
export { commitProposals } from "./commit/commit-service.js";

// ── Hooks ───────────────────────────────────────────────────────────
export { executeHooks, type HookContext, type HookExecutionResult } from "./hooks/hook-executor.js";

// ── Render ──────────────────────────────────────────────────────────
export { buildRenderResult } from "./render/render-builder.js";
