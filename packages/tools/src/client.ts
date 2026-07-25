/**
 * Result shape a tool execution can return: the bare output, or an envelope
 * carrying pending proposals / emitted events alongside it.
 */

import type { ToolExecutionEnvelope } from "./result.js";

export type ToolCallResult<TOutput = unknown> =
  TOutput | ToolExecutionEnvelope<TOutput>;
