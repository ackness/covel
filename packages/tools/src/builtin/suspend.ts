/**
 * Suspend builtin tool (S4-T4).
 *
 * When called by an agent runtime, returns a sentinel object that the
 * turn-executor recognises as a suspend signal (when COVEL_SUSPEND_V1=1).
 *
 * Flag-off behaviour: the sentinel is a regular tool result returned to the
 * LLM — no suspension is created, the turn continues normally.
 *
 * Plugins convert their Zod schemas to plain JSON Schema via `zod-to-json-schema`
 * before passing them to `resumeSchema`. Do NOT pass live Zod objects here.
 */

import { z } from "zod";
import { tool } from "../tool.js";
import type { ToolModule } from "../types.js";

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
		"Pause this runtime and wait for player input. The framework resumes the runtime when the player provides data matching the declared schema. Use this when you need player input before continuing.",
	parameters: z.object({
		reason: z
			.string()
			.min(1)
			.describe(
				"Short label shown to the player explaining why input is needed.",
			),
		resumeSchema: z
			.object({})
			.passthrough()
			.describe(
				"A plain JSON Schema object (type/properties/required) describing the expected shape of the player data passed to resume(). Convert Zod schemas via zod-to-json-schema before passing.",
			),
	}),
	execute: async ({ reason, resumeSchema }) => {
		// Returns the sentinel that turn-executor recognises when COVEL_SUSPEND_V1=1.
		// When flag is off, this is just a regular tool result the LLM receives.
		return {
			_covelSuspend: true,
			reason,
			resumeSchema,
		} satisfies SuspendSentinel;
	},
});
