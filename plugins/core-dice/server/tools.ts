import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import { rollCheck, rollDice } from "./dice-engine.js";
import type { RollCheckParams } from "./dice-engine.js";

/**
 * Tool handler for roll-check.
 * Performs a skill check and emits proposals for state and event tracking.
 */
export async function rollCheckTool(
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const input = (ctx.input ?? {}) as RollCheckParams;
  const result = rollCheck(input);

  const proposals: Array<{ kind: string; payload: unknown }> = [
    {
      kind: "event.emit",
      payload: {
        type: "dice_rolled",
        data: {
          skill: input.skill ?? null,
          system: input.system ?? "d20",
          result,
        },
      },
    },
    {
      kind: "state.patch",
      payload: {
        path: "lastRollResult",
        value: {
          skill: input.skill ?? null,
          system: input.system ?? "d20",
          ...result,
        },
      },
    },
  ];

  // Emit a UI block so the player sees the dice result
  proposals.push({
    kind: "ui.render",
    payload: {
      type: "dice_result",
      content: {
        skill: input.skill ?? null,
        ...result,
      },
    },
  });

  return { output: result, proposals };
}

/**
 * Tool handler for roll-dice.
 * Rolls arbitrary dice expressions and emits an event.
 */
export async function rollDiceTool(
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const input = (ctx.input ?? {}) as { expression: string };

  if (!input.expression) {
    throw new Error('roll-dice requires an "expression" parameter');
  }

  const result = rollDice(input.expression);

  const proposals: Array<{ kind: string; payload: unknown }> = [
    {
      kind: "event.emit",
      payload: {
        type: "dice_rolled",
        data: {
          system: "custom",
          expression: input.expression,
          result,
        },
      },
    },
  ];

  return { output: result, proposals };
}
