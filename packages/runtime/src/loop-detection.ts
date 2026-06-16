/**
 * Tool-loop detection + perturbation for the agent tool-call loop.
 *
 * When the LLM keeps emitting the exact same tool call (`name` + JSON
 * `arguments`) `threshold` times in a row it is almost certainly stuck in a
 * KV-cache echo. The first detection injects a perturbation system message to
 * nudge it onto a different path; a second detection throws so the loop cannot
 * wedge the runtime forever. Extracted from `turn-agent-tool-loop.ts` so the
 * main loop body reads as a sequence of named steps.
 */

import type { ToolCallRecord } from "@covel/shared";
import type { LLMMessage } from "./llm-adapter.js";
import { detectToolLoop, perturbMessages } from "./llm-retry.js";

export interface LoopGuardState {
  /** Number of perturbations already injected for this runtime. */
  loopPerturbations: number;
}

/**
 * Check the collected tool calls for a stuck loop. On the first detection a
 * perturbation hint is pushed onto `messages` (mutating the live array, as the
 * inline version did) and `state.loopPerturbations` is incremented. On a
 * second detection an error is thrown.
 *
 * No-op when `threshold <= 0`.
 */
export function guardAgainstToolLoop(args: {
  readonly collectedToolCalls: readonly ToolCallRecord[];
  readonly threshold: number;
  readonly runtimeName: string;
  readonly messages: LLMMessage[];
  readonly state: LoopGuardState;
}): void {
  const { collectedToolCalls, threshold, runtimeName, messages, state } = args;
  if (threshold <= 0) return;

  const identityCalls = collectedToolCalls.map((c) => ({
    name: c.toolName,
    arguments:
      typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {}),
  }));
  if (!detectToolLoop(identityCalls, threshold)) return;

  if (state.loopPerturbations >= 1) {
    throw new Error(
      `tool-loop detected for ${runtimeName}: same tool "${identityCalls[identityCalls.length - 1]?.name}" called ${threshold}+ times with identical arguments even after perturbation`,
    );
  }
  state.loopPerturbations++;
  const [hint] = perturbMessages([], 1, "tool-loop-detected");
  if (hint) {
    messages.push(hint);
    console.warn(
      `[runtime-loop] ${runtimeName} detected repeated tool call; injected perturbation (attempt ${state.loopPerturbations})`,
    );
  }
}
