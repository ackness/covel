// ── Types ───────────────────────────────────────────────────────────
export type {
  RuntimeContext,
  PromptAssemblyInput,
  PromptAssemblyResult,
  PromptSection,
  ToolDefinitionForPrompt,
  ContextSection,
  ToolExecutionContext,
  RuntimeExecutionResult,
  StructuredOutputStrategy,
  StructuredOutputConfig,
  RuntimeContextFactoryInput,
} from "./types.js";

// ── RuntimeContext Factory ───────────────────────────────────────────
export { createRuntimeContext } from "./runtime-context-factory.js";

// ── Prompt Assembly ─────────────────────────────────────────────────
export { assemblePrompt } from "./prompt-assembler.js";

// ── Structured Output ───────────────────────────────────────────────
export {
  parseStructuredOutput,
  validateJsonSchema,
  type ValidationResult,
  type StructuredOutputParseResult,
} from "./structured-output.js";

// ── Failure Helpers ─────────────────────────────────────────────────
export {
  createResult,
  successResult,
  failedResult,
  approvalDeniedResult,
  skippedConditionResult,
  skippedLimitResult,
  wrapAsPublishedRecord,
} from "./failure.js";
