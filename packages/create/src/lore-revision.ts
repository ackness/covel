import { playerVisibleLore } from "@covel/shared";
import type { CreateWorldOptions, WorldRevision } from "./types.js";
import {
  assertLoreFragment,
  hasLoreBoundary,
  LoreBoundaryError,
  matchingLoreParts,
  replaceLoreFragment,
  splitLore,
} from "./lore-boundaries.js";
import { parseWorldLoreRepairOutput } from "./lore-processor.js";
import { buildWorldLoreRevisionPrompt } from "./prompts.js";
import {
  LlmIdleTimeoutError,
  LlmIncompleteOutputError,
  requestLlmResponse,
} from "./llm-request.js";

/**
 * The package answer can edit hidden text and select public fragments to
 * revise, but cannot supply their replacement text. Public replacements use
 * only original public sources and the author's original instruction.
 */
export async function reviseProtectedLore(
  options: CreateWorldOptions & {
    readonly revision: WorldRevision;
    readonly proposed: string;
    readonly locale: string;
    readonly signal: AbortSignal;
  },
): Promise<string> {
  const { revision, proposed } = options;
  const source = splitLore(revision.current.lore);
  if (!hasLoreBoundary(source)) {
    splitLore(proposed);
    return proposed;
  }
  const target = matchingLoreParts(source, proposed);
  const output: string[] = [];
  for (const [index, part] of source.entries()) {
    const next = target[index]!;
    if (part.kind === "marker" || part.text.trim() === next.text.trim()) {
      output.push(part.text);
      continue;
    }
    if (part.hidden) {
      output.push(
        next.text.trim() ? replaceLoreFragment(part.text, next.text) : "\n",
      );
      continue;
    }
    try {
      const response = await requestLlmResponse({
        llm: options.llm,
        model: options.model,
        signal: options.signal,
        idleTimeoutMs: options.idleTimeoutMs,
        onUsage: options.onUsage,
        messages: [
          {
            role: "system",
            content: await buildWorldLoreRevisionPrompt(
              options.locale,
              options.loadPrompt,
            ),
          },
          {
            role: "user",
            content: JSON.stringify({
              authorInstruction: revision.instruction,
              publicContext: playerVisibleLore(revision.current.lore),
              fragment: part.text,
            }),
          },
        ],
      });
      const text = parseWorldLoreRepairOutput(response.content ?? "");
      if (text === null)
        throw new LoreBoundaryError(
          "Public WORLD.md fragment revision expected ===WORLD_MD=== and ===END=== delimiters with a nonempty fragment or UNCHANGED",
        );
      assertLoreFragment(text);
      output.push(
        /^UNCHANGED\s*\.?$/i.test(text)
          ? part.text
          : replaceLoreFragment(part.text, text),
      );
    } catch (error) {
      options.signal.throwIfAborted();
      if (
        error instanceof LlmIdleTimeoutError ||
        error instanceof LlmIncompleteOutputError ||
        error instanceof LoreBoundaryError
      )
        throw error;
      // Do not retry the whole package after an isolated replacement fails.
      throw new LoreBoundaryError(
        `Public WORLD.md fragment revision failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return output.join("");
}
