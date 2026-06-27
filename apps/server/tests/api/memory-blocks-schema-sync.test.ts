import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CORE_MEMORY_BLOCKS } from "@covel/memory";
import { parsePluginMd } from "@covel/plugin-loader";
import type { MemoryBlockSchema } from "@covel/shared";

/**
 * Drift guard: `DEFAULT_CORE_MEMORY_BLOCKS` (the `@covel/memory` engine
 * fallback) and the `memoryBlocks` declared in the builtin `memory` plugin's
 * PLUGIN.md are two hand-written copies of the same default block vocabulary.
 * In production the server aggregates the plugin's PLUGIN.md copy
 * (`collectMemoryBlockSchemas`), so the engine fallback exists only for
 * standalone/test boots — but the two must never diverge, or a player's blocks
 * silently change depending on whether the memory plugin is active.
 *
 * This test fails if either copy drifts (e.g. someone edits one `extractionHint`
 * and forgets the other), so the mismatch surfaces in CI instead of at runtime.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** Project each block to exactly the fields the contract pins, sorted by label. */
function normalize(
  blocks: readonly MemoryBlockSchema[],
): readonly Pick<
  MemoryBlockSchema,
  "label" | "displayName" | "icon" | "extractionHint"
>[] {
  return [...blocks]
    .map((b) => ({
      label: b.label,
      displayName: b.displayName,
      icon: b.icon,
      extractionHint: b.extractionHint,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function readPluginMemoryBlocks(
  file: string,
): Promise<readonly MemoryBlockSchema[]> {
  const abs = path.join(REPO_ROOT, "plugins", "memory", file);
  const content = await readFile(abs, "utf8");
  const parsed = parsePluginMd(content, abs);
  const blocks = parsed.manifest.memoryBlocks;
  if (!blocks || blocks.length === 0) {
    throw new Error(`plugins/memory/${file} declares no memoryBlocks`);
  }
  return blocks;
}

describe("memory plugin memoryBlocks <-> DEFAULT_CORE_MEMORY_BLOCKS sync", () => {
  it("PLUGIN.md (the production aggregation source) matches the engine fallback field-by-field", async () => {
    const declared = await readPluginMemoryBlocks("PLUGIN.md");
    expect(normalize(declared)).toEqual(normalize(DEFAULT_CORE_MEMORY_BLOCKS));
  });

  it("PLUGIN.en.md stays in sync with the engine fallback too", async () => {
    const declared = await readPluginMemoryBlocks("PLUGIN.en.md");
    expect(normalize(declared)).toEqual(normalize(DEFAULT_CORE_MEMORY_BLOCKS));
  });
});
