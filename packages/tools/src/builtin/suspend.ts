/**
 * Suspend builtin tool.
 *
 * When called by an agent runtime, returns a sentinel object that the
 * turn-executor recognises as a suspend signal.
 */

import { z } from "zod";
import { formFieldSchema, tool } from "@covel/plugin-handlers-utils";
import type { ToolModule } from "../types.js";
import { suspendFieldsToResumeSchema } from "./suspend-form.js";

/** Sentinel shape that turn-executor checks after each tool execution. */
export interface SuspendSentinel {
  readonly _covelSuspend: true;
  readonly reason: string;
  readonly resumeSchema: unknown;
}

/** Type guard for the suspend sentinel. */
export function isSuspendSentinel(value: unknown): value is SuspendSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["_covelSuspend"] === true &&
    typeof (value as Record<string, unknown>)["reason"] === "string" &&
    "resumeSchema" in (value as Record<string, unknown>)
  );
}

export const suspendTool: ToolModule = tool({
  name: "suspend",
  description:
    "Pause this runtime and wait for player input. The framework resumes the runtime when the player provides data matching the declared form fields. Use this when you need player input before continuing.",
  parameters: z.object({
    reason: z
      .string()
      .min(1)
      .describe(
        "Short label shown to the player explaining why input is needed.",
      ),
    fields: z
      .array(formFieldSchema)
      .min(1)
      .superRefine((fields, ctx) => {
        const names = new Set<string>();
        fields.forEach((field, index) => {
          if (!field.name.trim() || names.has(field.name))
            ctx.addIssue({
              code: "custom",
              path: [index, "name"],
              message: "Field names must be non-empty and unique",
            });
          names.add(field.name);
          if (field.type === "select" && !field.options?.length)
            ctx.addIssue({
              code: "custom",
              path: [index, "options"],
              message: "A select needs at least one option",
            });
        });
      })
      .describe(
        "Answer fields using the create-form field objects. The answer is an object keyed by field name.",
      ),
  }),
  execute: async ({ reason, fields }) => {
    // Returns the sentinel that turn-executor recognises as a suspend signal.
    return {
      _covelSuspend: true,
      reason,
      resumeSchema: suspendFieldsToResumeSchema(fields),
    } satisfies SuspendSentinel;
  },
});
