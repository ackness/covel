// ── Tool definition ──────────────────────────────────────────────
export { tool } from './tool.js';

// ── Registry ─────────────────────────────────────────────────────
export { createToolRegistry, generateToolName } from './registry.js';
export type { ToolRegistry } from './registry.js';

// ── Output validation ────────────────────────────────────────────
export { validateOutput, selectOutputStrategy, generateSchemaPrompt } from './output-validator.js';

// ── Built-in tools ───────────────────────────────────────────────
export { createFormTool, createChoicesTool, createNotificationTool, builtinUITools } from './builtin/ui-tools.js';

// ── Types ────────────────────────────────────────────────────────
export type {
  ToolExecutionContext,
  ToolModule,
  ToolDefinitionInput,
  ToolSource,
  ResolvedTool,
  StructuredOutputStrategy,
  ValidationResult,
} from './types.js';
