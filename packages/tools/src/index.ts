// ── Tool definition ──────────────────────────────────────────────
export { tool, ToolValidationError } from './tool.js';
export { getPendingProposals, getToolContent, withPendingProposals } from './result.js';
export type { ToolExecutionEnvelope } from './result.js';

// ── Zod re-export (for plugin tool factory injection) ───────────
export { z } from 'zod';

// ── Registry ─────────────────────────────────────────────────────
export { createToolRegistry, generateToolName } from './registry.js';
export type { ToolRegistry } from './registry.js';

// ── Output validation ────────────────────────────────────────────
export { validateOutput, selectOutputStrategy, generateSchemaPrompt } from './output-validator.js';

// ── Built-in tools ───────────────────────────────────────────────
export { createFormTool, createChoicesTool, createNotificationTool, builtinUITools } from './builtin/ui-tools.js';
export { createPluginDataTools } from './builtin/plugin-data-tools.js';
export { createCharacterTools } from './builtin/character-tools.js';
export type { CharacterStore } from './builtin/character-tools.js';
export { createWorldDimensionTools } from './builtin/world-dimension-tools.js';
export type { WorldDimensionToolDeps } from './builtin/world-dimension-tools.js';
export { suspendTool, isSuspendSentinel } from './builtin/suspend.js';
export type { SuspendSentinel } from './builtin/suspend.js';
export { runtimeDoneTool, isRuntimeDoneSentinel } from './builtin/runtime-done.js';
export type { RuntimeDoneSentinel } from './builtin/runtime-done.js';
export { createMemoryTools } from './builtin/memory-tools.js';
export type { MemoryToolDeps } from './builtin/memory-tools.js';

// ── Short ID (LLM-friendly entity references) ──────────────────
export { shortId, shortIdBatch, clearSessionCounters } from './short-id.js';

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
