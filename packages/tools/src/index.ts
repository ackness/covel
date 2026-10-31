// ── Tool definition ──────────────────────────────────────────────
export {
  tool,
  toolParametersJsonSchema,
  ToolValidationError,
} from "@covel/plugin-handlers-utils";
export { parseJsonText } from "@covel/plugin-handlers-utils";
export { ToolRegistry, FRAMEWORK_TOOL_NAMES } from "./registry.js";
export {
  getPendingProposals,
  getToolContent,
  withPendingProposals,
  getEmittedEvents,
  withEmittedEvents,
  ToolError,
  isToolError,
  withModelView,
  getModelView,
} from "./result.js";
export type {
  ToolErrorCode,
  ToolExecutionEnvelope,
  EmittedEvent,
} from "./result.js";

// ── Proposal read-through overlays (buffered same-execution writes) ──
export {
  overlayPluginDataValue,
  overlayPluginDataRows,
  overlayCharacters,
} from "./proposal-overlay.js";

// ── Zod re-export (for plugin tool factory injection) ───────────
export { z } from "zod";

// ── Tool client ──────────────────────────────────────────────────
export type { ToolCallResult } from "./client.js";

// ── Output validation ────────────────────────────────────────────
export { validateOutput } from "./output-validator.js";

// ── Character schema validation ──────────────────────────────────
export { validateFieldsAgainstSchema } from "./schema-validator.js";
export type {
  SchemaValidationResult,
  SchemaValidationIssue,
} from "./schema-validator.js";

// ── Built-in tools ───────────────────────────────────────────────
export {
  renderUITool,
  createFormTool,
  createChoicesTool,
  createNotificationTool,
  builtinUITools,
} from "@covel/plugin-handlers-utils";
export { createPluginDataTools } from "./builtin/plugin-data-tools.js";
export {
  createCharacterTools,
  buildSessionCharacterWriteTools,
} from "./builtin/character-tools.js";
export type {
  CharacterStore,
  CharacterSnapshot,
} from "./builtin/character-tools.js";
export { buildFieldsZodFromSchema } from "@covel/shared";
export { suspendTool, isSuspendSentinel } from "./builtin/suspend.js";
export { suspendFieldsToResumeSchema } from "./builtin/suspend-form.js";
export type { SuspendSentinel } from "./builtin/suspend.js";
export {
  runtimeDoneTool,
  isRuntimeDoneSentinel,
} from "./builtin/runtime-done.js";
export type { RuntimeDoneSentinel } from "./builtin/runtime-done.js";
export {
  SEARCH_TOOLS_TOOL_NAME,
  SEARCH_TOOLS_DEFAULT_LIMIT,
  SEARCH_TOOLS_MAX_LIMIT,
  SEARCH_TOOLS_JSON_SCHEMA,
  buildSearchToolsDescription,
  rankToolSearchDocs,
  tokenizeForToolSearch,
  parameterSchemaSearchText,
} from "./builtin/tool-search.js";
export type { ToolSearchDoc } from "./builtin/tool-search.js";
export {
  delegateTool,
  delegateParametersSchema,
  DELEGATE_TOOL_NAME,
  SUBAGENT_BRIEF_MAX_CHARS,
} from "./builtin/delegate.js";
export { createMemoryTools } from "./builtin/memory-tools.js";
export type { MemoryToolDeps } from "./builtin/memory-tools.js";
export {
  createEmitEventTool,
  buildSessionEmitEventTool,
  schemaHasReferences,
} from "./builtin/emit-event.js";
export type { EventDirectoryLike } from "./builtin/emit-event.js";
export { createDefaultToolRegistry } from "./builtin/default-tools.js";
export type { DefaultToolRegistryDeps } from "./builtin/default-tools.js";

export {
  worldDimensionGetTool,
  worldDimensionListTool,
} from "./builtin/world-dimension-tools.js";

// ── Short ID (LLM-friendly entity references) ──────────────────
export {
  shortId,
  shortIdBatch,
  wordId,
  wordSlug,
} from "@covel/plugin-handlers-utils";

// ── Types ────────────────────────────────────────────────────────
export type {
  ToolExecutionContext,
  ToolModule,
  ToolDefinitionInput,
  ToolAnnotations,
  PluginToolAnnotations,
  ToolSource,
  ValidationResult,
} from "./types.js";
