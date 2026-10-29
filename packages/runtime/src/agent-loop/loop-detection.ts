/**
 * Tool-loop detection + perturbation for the agent tool-call loop.
 *
 * When the LLM keeps emitting the exact same tool call (`name` + JSON
 * `arguments`) `threshold` times in a row it is almost certainly stuck in a
 * KV-cache echo. Detections spend the profile's perturbation budget to nudge
 * it onto a different path, then throw so the loop can apply its fallback.
 * Extracted from `turn-agent-tool-loop.ts` so the main loop body reads as a
 * sequence of named steps.
 */

import type { ToolCallRecord } from "@covel/shared";
import type { LLMMessage } from "@covel/shared";
import type { CorrectionPolicy } from "./correction-policy.js";
import { detectToolLoop } from "../retry/llm-retry.js";
import { perturbMessages } from "../retry/retry-common.js";

/**
 * Inject a perturbation while its budget remains; otherwise use the loop fallback.
 * No-op when `threshold <= 0`.
 */
export function guardAgainstToolLoop(args: {
  readonly collectedToolCalls: readonly ToolCallRecord[];
  readonly threshold: number;
  readonly runtimeName: string;
  readonly messages: LLMMessage[];
  readonly policy: CorrectionPolicy;
  readonly locale?: string;
}): void {
  const { collectedToolCalls, threshold, runtimeName, messages, policy } = args;
  if (threshold <= 0) return;

  const identityCalls = collectedToolCalls.map((c) => ({
    name: c.toolName,
    arguments:
      typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {}),
  }));
  if (!detectToolLoop(identityCalls, threshold)) return;

  if (!policy.take("loopPerturbation")) {
    throw new Error(
      `tool-loop detected for ${runtimeName}: same tool "${identityCalls[identityCalls.length - 1]?.name}" called ${threshold}+ times with identical arguments even after perturbation`,
    );
  }
  const [hint] = perturbMessages([], 1, "tool-loop-detected", args.locale);
  if (hint) {
    messages.push(hint);
    console.warn(
      `[runtime-loop] ${runtimeName} detected repeated tool call; injected perturbation (attempt ${policy.used("loopPerturbation")})`,
    );
  }
}
