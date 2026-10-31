/**
 * Delegate builtin tool: an agent runtime runs another agent runtime as a
 * sub-agent and receives its output.
 *
 * The kernel answers this call itself inside the agent loop (the runtime
 * wraps its tool executor; see `agent-loop/subagent-delegate.ts`), so
 * `execute` is never reached there. The module is registered so the name is
 * reserved, advertised to runtimes that declare it in `tools.builtin`, and
 * authorized like any other builtin.
 */

import { z } from "zod";
import { tool } from "@covel/plugin-handlers-utils";
import type { ToolModule } from "../types.js";

export const DELEGATE_TOOL_NAME = "delegate";

/** Longest brief a sub-agent accepts. */
export const SUBAGENT_BRIEF_MAX_CHARS = 20_000;

const targetSchema = z.union([
  z.strictObject({
    contract: z
      .string()
      .min(1)
      .describe("Agent contract whose sub-agent provider runs the task."),
  }),
  z.strictObject({
    runtimeId: z
      .string()
      .min(1)
      .describe("A sub-agent runtime of your own plugin."),
  }),
]);

/** Arguments of `delegate`, as the model writes them. */
export const delegateParametersSchema = z.strictObject({
  target: targetSchema.describe(
    "Who runs the task: { contract } or { runtimeId }, never both.",
  ),
  brief: z
    .string()
    .min(1)
    .max(SUBAGENT_BRIEF_MAX_CHARS)
    .describe(
      "The whole task. The sub-agent sees only this brief and data, not this conversation.",
    ),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Structured facts the sub-agent needs, as a JSON object."),
  maxSteps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Lower step limit for the sub-agent; never raises its own."),
});

export const delegateTool: ToolModule = tool({
  name: DELEGATE_TOOL_NAME,
  description:
    "Run another agent as a sub-agent and get its output back. It works from your brief and data only, can stage changes through write services when allowed in this run, and returns its output or an error you can act on. Staged changes take effect at turn end and may still be rejected.",
  annotations: {
    readOnly: false,
    stagesWrites: true,
    idempotent: false,
    concurrencySafe: false,
  },
  parameters: delegateParametersSchema,
  execute: async () => {
    throw new Error("delegate runs only inside an agent loop");
  },
});
