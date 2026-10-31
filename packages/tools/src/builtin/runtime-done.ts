/**
 * Completion sentinel for system agents whose resolved completion rule uses it.
 * The runtime ends after the response containing a successful call.
 */

import { z } from "zod";
import { withModelView, tool } from "@covel/plugin-handlers-utils";
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
  description:
    "Call this last, only after every needed tool call has succeeded or when nothing needs doing. It records nothing. The run ends after this response; do not make more calls or write more prose.",
  parameters: z.object({
    reason: z.string().optional().describe("Optional note kept in the trace."),
  }),
  execute: async ({ reason }) => {
    return withModelView(
      { _covelRuntimeDone: true, reason } satisfies RuntimeDoneSentinel,
      { summary: "Run finished." },
    );
  },
});
