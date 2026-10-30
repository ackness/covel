import type { LLMAdapter, LLMUsageSummary } from "@covel/shared";
import type { PromptLoader } from "@covel/context";
import { parseWorldLoreRepairOutput } from "./lore-processor.js";
import { requestLlmResponse } from "./llm-request.js";
import { buildWorldLoreRepairPrompt } from "./prompts.js";
import {
  assertLoreFragment,
  replaceLoreFragment,
  splitLore,
} from "./lore-boundaries.js";
import { findLoreMetaErrors } from "./validation-helpers.js";

interface WorldLoreRepairOptions {
  readonly llm: LLMAdapter;
  readonly model?: string;
  readonly locale: string;
  readonly lore: string;
  readonly errors: readonly string[];
  readonly signal: AbortSignal;
  readonly idleTimeoutMs?: number;
  readonly onUsage?: (usage: LLMUsageSummary) => void;
  readonly loadPrompt?: PromptLoader;
}

export type WorldLoreRepairResult =
  | { readonly success: true; readonly lore: string }
  | { readonly success: false; readonly error: string };

export async function repairWorldLore(
  options: WorldLoreRepairOptions,
): Promise<WorldLoreRepairResult> {
  const parts = splitLore(options.lore);
  const output: string[] = [];
  for (const part of parts) {
    if (part.kind === "marker" || findLoreMetaErrors(part.text).length === 0) {
      output.push(part.text);
      continue;
    }
    const result = await repairFragment({ ...options, lore: part.text.trim() });
    if (!result.success) return result;
    assertLoreFragment(result.lore);
    output.push(replaceLoreFragment(part.text, result.lore));
  }
  return { success: true, lore: output.join("") };
}

async function repairFragment(
  options: WorldLoreRepairOptions,
): Promise<WorldLoreRepairResult> {
  const systemPrompt = await buildWorldLoreRepairPrompt(
    options.locale,
    options.loadPrompt,
  );
  const response = await requestLlmResponse({
    llm: options.llm,
    model: options.model,
    signal: options.signal,
    idleTimeoutMs: options.idleTimeoutMs,
    onUsage: options.onUsage,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          "Repair only this isolated WORLD.md fragment. Preserve its existing headings and hooks; do not add missing ones.",
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
