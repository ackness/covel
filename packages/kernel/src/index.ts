// ── Kernel ──────────────────────────────────────────────────────────
export { createKernel, type Kernel, type KernelDeps, type KernelContext } from "./kernel.js";

// ── Types ───────────────────────────────────────────────────────────
export type {
  CandidateRuntime,
  ScheduledRuntime,
  ExecutionPlan,
  TurnState,
  KernelExecuteOptions,
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

// ── Proposals ───────────────────────────────────────────────────────
export { createProposalCollector, type ProposalCollector } from "./proposals/proposal-collector.js";
export { validateProposals, type ValidationResult } from "./proposals/proposal-validator.js";

// ── Commit ──────────────────────────────────────────────────────────
export { commitProposals } from "./commit/commit-service.js";

// ── Render ──────────────────────────────────────────────────────────
export { buildRenderResult } from "./render/render-builder.js";
