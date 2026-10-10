import { estimateTokens } from "@covel/plugin-handlers-utils";

/**
 * How much of a world's lore a story prompt carries, in estimated tokens.
 *
 * The limit is in tokens, not characters: the same lore takes about four times
 * as many characters in English as in Chinese, so a limit in characters cut an
 * English edition long before its Chinese original.
 */
export const WORLD_LORE_TOKEN_BUDGET = 8000;

export interface FittedWorldLore {
  /** The lore the prompt carries; ends with `…` when it was cut. */
  readonly text: string;
  /** Estimated tokens of the whole lore. */
  readonly tokens: number;
  readonly truncated: boolean;
}

/**
 * The part of a world's lore that fits the story prompt. Lore over the budget
 * is cut after its last line that fits, never inside one, so the prompt does
 * not end in half a sentence. `validate:world` warns with this same measure.
 */
export function fitWorldLore(
  lore: string,
  estimator: (text: string) => number = estimateTokens,
): FittedWorldLore {
  const tokens = estimator(lore);
  if (tokens <= WORLD_LORE_TOKEN_BUDGET)
    return { text: lore, tokens, truncated: false };
  const kept: string[] = [];
  let used = 0;
  for (const line of lore.split("\n")) {
    used += estimator(`${line}\n`);
    if (used > WORLD_LORE_TOKEN_BUDGET) break;
    kept.push(line);
  }
  return {
    text: `${kept.join("\n").trimEnd()}\n…`,
    tokens,
    truncated: true,
  };
}
