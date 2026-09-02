import type { LLMAdapter } from "@covel/shared";
import { parseWorldLoreRepairOutput } from "./lore-processor.js";
import { requestLlmResponse } from "./llm-request.js";
import { buildWorldLoreRepairPrompt } from "./prompts.js";

interface WorldLoreRepairOptions {
  readonly llm: LLMAdapter;
  readonly model?: string;
  readonly locale: string;
  readonly lore: string;
  readonly errors: readonly string[];
  readonly signal: AbortSignal;
}

export type WorldLoreRepairResult =
  | { readonly success: true; readonly lore: string }
  | { readonly success: false; readonly error: string };

export async function repairWorldLore(
  options: WorldLoreRepairOptions,
): Promise<WorldLoreRepairResult> {
  const systemPrompt = await buildWorldLoreRepairPrompt(options.locale);
  const response = await requestLlmResponse({
    llm: options.llm,
    model: options.model,
    signal: options.signal,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          "Repair the WORLD.md below.",
          `Validation errors:\n${options.errors.join("\n")}`,
          "",
          "===WORLD_MD_INPUT===",
          options.lore,
          "===END_WORLD_MD_INPUT===",
        ].join("\n"),
      },
    ],
  });

  if (!response.content) {
    return { success: false, error: "LLM returned an empty repair response" };
  }

  const lore = parseWorldLoreRepairOutput(response.content);
  if (!lore) {
    return {
      success: false,
      error: "expected ===WORLD_MD=== and ===END=== delimiters",
    };
  }
  return { success: true, lore };
}
