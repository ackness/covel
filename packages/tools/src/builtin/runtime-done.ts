/**
 * Runtime-done builtin tool.
 *
 * Auto-registered on every agent runtime. Lets the LLM declare "I'm done"
 * without the framework having to round-trip another LLM call just so the
 * model can write a terminator message.
 *
 * Single-shot plugins (guide / codex / character-tracker / npc-graph
 * extractor / world-init schema-gen) follow this pattern:
 *   1. Call their business tool once (e.g. `generate-guide`)
 *   2. Immediately call `runtime-done` to finish
 *
 * The turn-executor detects the sentinel after each tool execution and
 * breaks out of the agent loop, using the preceding business tool calls as
 * the runtime's final output.
 *
 * Pattern mirrors `suspend` — sentinel + type guard + early exit.
 */

import { z } from "zod";
import { tool } from "../tool.js";
import type { ToolModule } from "../types.js";

/** Sentinel shape the turn-executor checks after each tool call. */
export interface RuntimeDoneSentinel {
  readonly _covelRuntimeDone: true;
  readonly reason?: string;
}

/** Type guard for the runtime-done sentinel. */
export function isRuntimeDoneSentinel(
  value: unknown,
): value is RuntimeDoneSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["_covelRuntimeDone"] === true
  );
}

export const runtimeDoneTool: ToolModule = tool({
  name: "runtime-done",
  description: "Finish this runtime after all required tool calls.",
  parameters: z.object({
    reason: z.string().optional().describe("Optional trace note."),
  }),
  execute: async ({ reason }) => {
    return { _covelRuntimeDone: true, reason } satisfies RuntimeDoneSentinel;
  },
});
