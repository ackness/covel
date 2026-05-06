/**
 * Tool system types.
 */

import type { z, ZodType } from "zod";
import type { Proposal } from "@covel/shared";
import type { ToolExecutionEnvelope } from "./result.js";

// ── Tool execution context ───────────────────────────────────────

export interface ToolExecutionContext {
	readonly sessionId: string;
	readonly turnId: string;
	readonly pluginId: string;
	readonly runtimeId: string;
	/**
	 * Proposal writes buffered earlier in the same tool loop.
	 * Tools can consult this view to read same-turn plugin-data updates
	 * before the session kernel commits them at runtime end.
	 */
	readonly pendingProposals?: readonly Proposal[];
}

// ── Tool module (result of tool() call) ──────────────────────────

export interface ToolModule<
	TParams extends ZodType = ZodType,
	TOutput = unknown,
> {
	readonly _type: "covel-tool";
	readonly name: string;
	readonly description: string;
	readonly parametersSchema: TParams;
	readonly jsonSchema: Readonly<Record<string, unknown>>;
	execute(
		params: z.infer<TParams>,
		context: ToolExecutionContext,
	): Promise<TOutput | ToolExecutionEnvelope<TOutput>>;
}

// ── Tool definition input (passed to tool()) ─────────────────────

export interface ToolDefinitionInput<
	TParams extends ZodType = ZodType,
	TOutput = unknown,
> {
	readonly name: string;
	readonly description: string;
	readonly parameters: TParams;
	execute(
		params: z.infer<TParams>,
		context: ToolExecutionContext,
	): Promise<TOutput | ToolExecutionEnvelope<TOutput>>;
}

// ── Resolved tool (registered in registry) ───────────────────────

export type ToolSource = "builtin" | "local";

export interface ResolvedTool {
	/** Full name: covel_{plugin}_{runtime}_{fn} */
	readonly fullName: string;
	/** Original function name */
	readonly localName: string;
	readonly pluginId: string;
	readonly runtimeId: string;
	readonly module: ToolModule;
	readonly source: ToolSource;
	readonly requiresApproval: boolean;
}

// ── Output validation ────────────────────────────────────────────

export type StructuredOutputStrategy = "native" | "prompt";

export interface ValidationResult {
	readonly valid: boolean;
	readonly errors?: readonly string[];
}
