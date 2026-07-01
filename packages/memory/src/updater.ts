/**
 * Memory Updater — Post-turn LLM-driven core memory refresh.
 *
 * After each turn completes, the updater:
 *   1. Reads the current core memory blocks
 *   2. Reads the turn's narrative output + tool call summaries
 *   3. Calls a cheap LLM (memory slot → story fallback) with a structured prompt
 *   4. Parses the JSON response to get block updates
 *   5. Writes only the changed blocks
 *
 * The extraction prompt and the set of valid block labels are **schema-driven**
 * (see {@link MemoryUpdaterConfig.blocks}): each block's `extractionHint` is
 * composed into the summarizer's system prompt. The framework owns the
 * mechanism; plugins/worlds own the block vocabulary. No world-specific
 * content lives here.
 *
 * Inspired by Letta's `memory_rethink` tool, but framework-controlled
 * rather than free-form LLM editing.
 */

import { resolveI18nText } from "@covel/shared";
import type {
  CoreMemoryBlock,
  CoreMemoryBlockSchema,
  CoreMemoryLabel,
  MemoryLLMAdapter,
  MemoryManager,
  MemoryUpdateResult,
  MemoryUpdaterConfig,
} from "./types.js";
import { DEFAULT_CORE_MEMORY_BLOCKS } from "./types.js";

/**
 * Build the memory-manager system prompt for a given block schema + locale.
 * The per-block descriptions come from each block's `extractionHint`, so the
 * prompt carries no hardcoded, setting-specific vocabulary.
 */
function buildSystemPrompt(
  blocks: readonly CoreMemoryBlockSchema[],
  lang: "zh" | "en",
  locale: string,
): string {
  if (lang === "zh") {
    const descriptions = blocks
      .map(
        (b) =>
          `- **${b.label}**：${resolveI18nText(b.extractionHint, locale) ?? ""}`,
      )
      .join("\n");
    return `你是一个记忆管理器。你的任务是根据本轮新发生的故事事件，更新游戏的核心记忆块。

## 记忆块说明

${descriptions}

## 输出格式

只输出一个 JSON 对象，key 是需要更新的块标签，value 是**完整的新内容**（不是增量）。
只输出有变化的块。如果本轮没有值得更新的信息，输出 \`{}\`。

每个块内容控制在 300-500 字以内，使用简洁的事实陈述，不要用文学化的描写。

示例输出（用实际的块标签替换）：

\`\`\`json
{ "<块标签>": "<该块的完整新内容>" }
\`\`\``;
  }

  const descriptions = blocks
    .map(
      (b) =>
        `- **${b.label}**: ${resolveI18nText(b.extractionHint, locale) ?? ""}`,
    )
    .join("\n");
  return `You are a memory manager. Your task is to update the game's core memory blocks based on new story events from the current turn.

## Memory Block Descriptions

${descriptions}

## Output Format

Output a single JSON object where keys are block labels that need updating and values are the **complete new content** (not incremental).
Only output blocks that changed. If nothing worth updating happened, output \`{}\`.

Keep each block under 300-500 words. Use concise factual statements, not literary descriptions.

Example output (replace with actual block labels):

\`\`\`json
{ "<block_label>": "<complete new content for that block>" }
\`\`\``;
}

export function createMemoryUpdater(
  manager: MemoryManager,
  llm: MemoryLLMAdapter,
  config?: MemoryUpdaterConfig,
): {
  updateAfterTurn(params: {
    sessionId: string;
    narrativeText: string;
    toolCallSummaries?: readonly string[];
    currentBlocks: readonly CoreMemoryBlock[];
    locale?: string;
  }): Promise<MemoryUpdateResult>;
  awaitPending(sessionId: string): Promise<void>;
} {
  const resolvedLocale = config?.locale ?? "zh-CN";
  const staticSchema = config?.blocks ?? DEFAULT_CORE_MEMORY_BLOCKS;

  // Per-session pending-promise map. Tracks the most recent in-flight
  // updateAfterTurn() call so the next turn can await it before reading
  // blocks. Stale-by-one-turn memory is acceptable (intentional trade-off)
  // but stale-mid-turn is not — especially when players spam submit.
  const pending = new Map<string, Promise<unknown>>();

  async function runUpdate(params: {
    sessionId: string;
    narrativeText: string;
    toolCallSummaries?: readonly string[];
    currentBlocks: readonly CoreMemoryBlock[];
    locale?: string;
  }): Promise<MemoryUpdateResult> {
    const {
      sessionId,
      narrativeText,
      toolCallSummaries,
      currentBlocks,
      locale,
    } = params;
    const effectiveLocale = locale ?? resolvedLocale;
    const lang = effectiveLocale.startsWith("zh") ? "zh" : "en";

    // Resolve the block schema for this session (plugin blocks merged with the
    // session's world-declared blocks) so world memory dimensions are extracted
    // for the worlds that declare them. Falls back to the static schema.
    const schema = (await config?.resolveBlocks?.(sessionId)) ?? staticSchema;
    const validLabels = new Set<string>(schema.map((b) => b.label));

    // Build user prompt with current blocks + new events
    const blockSection = currentBlocks
      .filter((b) => b.content.trim())
      .map((b) => `[${b.label}]\n${b.content}`)
      .join("\n\n");

    const toolSection = toolCallSummaries?.length
      ? `\n\n## 本轮工具调用摘要\n${toolCallSummaries.join("\n")}`
      : "";

    const userPrompt = `## 当前记忆块\n${blockSection || "（全部为空，首次初始化）"}\n\n## 本轮叙事\n${narrativeText}${toolSection}\n\n请输出需要更新的记忆块 JSON。`;

    try {
      const response = await llm.complete({
        systemPrompt: buildSystemPrompt(schema, lang, effectiveLocale),
        messages: [{ role: "user", content: userPrompt }],
        model: config?.modelSlot,
      });

      const parsed = parseBlockUpdates(response.content, validLabels);
      if (parsed.size === 0) {
        return { updated: false, blocksChanged: [] };
      }

      await manager.updateBlocks(sessionId, parsed);

      return {
        updated: true,
        blocksChanged: [...parsed.keys()],
      };
    } catch (err) {
      // Memory update failure is non-fatal — blocks stay unchanged
      return {
        updated: false,
        blocksChanged: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    updateAfterTurn(params): Promise<MemoryUpdateResult> {
      // Chain this call behind any in-flight update for the same session so
      // we never race two LLM completions writing the same block, and so
      // `awaitPending` can serialise on the latest write.
      const previous = pending.get(params.sessionId) ?? Promise.resolve();
      const next = previous
        .catch(() => {
          /* previous failure already reported to its caller */
        })
        .then(() => runUpdate(params));
      // Store a promise that resolves regardless of success/failure.
      pending.set(
        params.sessionId,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },
    async awaitPending(sessionId: string): Promise<void> {
      const p = pending.get(sessionId);
      if (!p) return;
      try {
        await p;
      } catch {
        // Errors already surfaced to the original caller via its returned
        // MemoryUpdateResult; swallow here so awaitPending never throws.
      }
    },
  };
}

/**
 * Parse the LLM response into a map of block updates.
 * Handles: raw JSON, markdown-wrapped JSON, partial responses.
 * Only labels present in {@link validLabels} are accepted.
 */
function parseBlockUpdates(
  raw: string,
  validLabels: ReadonlySet<string>,
): Map<CoreMemoryLabel, string> {
  const result = new Map<CoreMemoryLabel, string>();

  // Strip markdown code fences if present
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try JSON parse
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON from surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return result;
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch {
      return result;
    }
  }

  // Extract valid block updates
  for (const [key, value] of Object.entries(obj)) {
    if (validLabels.has(key) && typeof value === "string" && value.trim()) {
      result.set(key, value.trim());
    }
  }

  return result;
}
