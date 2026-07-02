/**
 * Unified tool client contract.
 */

import type { ToolExecutionContext, ResolvedTool } from "./types.js";
import type { ToolExecutionEnvelope } from "./result.js";

export type ToolDefinition = ResolvedTool;

export type ToolCallResult<TOutput = unknown> =
  | TOutput
  | ToolExecutionEnvelope<TOutput>;

export interface ToolClient {
  readonly id: string;
  list(): Promise<readonly ToolDefinition[]>;
  call(
    name: string,
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult>;
  close?(): Promise<void>;
}
