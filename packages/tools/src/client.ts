/**
 * Unified tool client contract.
 */

import type { ToolExecutionContext, ResolvedTool } from "./types.js";
import type { ToolExecutionEnvelope } from "./result.js";

export type ToolTransport = "in-memory" | "stdio" | "http" | "sse";

export type ToolDefinition = ResolvedTool;

export type ToolCallResult<TOutput = unknown> =
	| TOutput
	| ToolExecutionEnvelope<TOutput>;

export interface ToolClient {
	readonly transport: ToolTransport;
	readonly id: string;
	list(): Promise<readonly ToolDefinition[]>;
	call(
		name: string,
		args: unknown,
		ctx: ToolExecutionContext,
	): Promise<ToolCallResult>;
	close?(): Promise<void>;
}

export interface ToolClientEntry {
	readonly tool: ResolvedTool;
	readonly client: ToolClient;
}
