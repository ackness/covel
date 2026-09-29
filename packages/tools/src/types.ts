/** Public author contracts have one source in the standalone SDK. */
import type { ZodType } from "zod";
import type {
  PluginToolContext,
  PluginToolDefinition,
  PluginToolModule,
} from "@covel/plugin-handlers-utils";

export type ToolExecutionContext = PluginToolContext;
export type ToolModule<
  TParams extends ZodType = ZodType,
  TOutput = unknown,
> = PluginToolModule<TParams, TOutput>;
export type ToolDefinitionInput<
  TParams extends ZodType = ZodType,
  TOutput = unknown,
> = PluginToolDefinition<TParams, TOutput>;

// ── Tool provenance ──────────────────────────────────────────────

export type ToolSource = "builtin" | "local";

// ── Output validation ────────────────────────────────────────────

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly string[];
}
