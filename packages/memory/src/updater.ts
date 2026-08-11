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
  MemoryAuthoritativeFacts,
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
如果用户消息中的“会话事实（权威）”与叙事、推断或旧记忆冲突，必须以会话事实为准。

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
If "Authoritative Session Facts" conflict with the narrative, an inference, or an older memory block, the authoritative facts always win.

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
    authoritativeFacts?: MemoryAuthoritativeFacts;
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
    authoritativeFacts?: MemoryAuthoritativeFacts;
    currentBlocks: readonly CoreMemoryBlock[];
    locale?: string;
  }): Promise<MemoryUpdateResult> {
    const {
      sessionId,
      narrativeText,
      toolCallSummaries,
      authoritativeFacts,
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

    const toolSection = toolCallSummaries?.length
      ? `\n\n## 本轮工具调用摘要\n${toolCallSummaries.join("\n")}`
      : "";

    const authoritativeSection = buildAuthoritativeFactsSection(
      authoritativeFacts,
      lang,
    );

    let authoritativeBlocksChanged: CoreMemoryLabel[] = [];

    try {
      // Persist confirmed character fields before waiting on the summarizer.
      // This deterministic correction must survive a slow or failed LLM call.
      const authoritativeUpdates = new Map<CoreMemoryLabel, string>();
      enforceAuthoritativePlayerProfile({
        updates: authoritativeUpdates,
        currentBlocks,
        authoritativeFacts,
        lang,
      });
      if (authoritativeUpdates.size > 0) {
        await manager.updateBlocks(sessionId, authoritativeUpdates);
        authoritativeBlocksChanged = [...authoritativeUpdates.keys()];
      }

      const effectiveCurrentBlocks = applyUpdatesToBlockSnapshot(
        currentBlocks,
        authoritativeUpdates,
      );
      const blockSection = effectiveCurrentBlocks
        .filter((b) => b.content.trim())
        .map((b) => `[${b.label}]\n${b.content}`)
        .join("\n\n");
      const userPrompt = `## 当前记忆块\n${blockSection || "（全部为空，首次初始化）"}${authoritativeSection}\n\n## 本轮叙事\n${narrativeText}${toolSection}\n\n请输出需要更新的记忆块 JSON。`;

      const response = await llm.complete({
        systemPrompt: buildSystemPrompt(schema, lang, effectiveLocale),
        messages: [{ role: "user", content: userPrompt }],
        model: config?.modelSlot,
      });

      const parsed = parseBlockUpdates(response.content, validLabels);
      enforceAuthoritativePlayerProfile({
        updates: parsed,
        currentBlocks: effectiveCurrentBlocks,
        authoritativeFacts,
        lang,
      });
      if (parsed.size === 0) {
        return {
          updated: authoritativeBlocksChanged.length > 0,
          blocksChanged: authoritativeBlocksChanged,
        };
      }

      await manager.updateBlocks(sessionId, parsed);

      return {
        updated: true,
        blocksChanged: [
          ...new Set([...authoritativeBlocksChanged, ...parsed.keys()]),
        ],
      };
    } catch (err) {
      // Dynamic-summary failure is non-fatal. A deterministic authoritative
      // correction that already landed remains valid and is reported as such.
      return {
        updated: authoritativeBlocksChanged.length > 0,
        blocksChanged: authoritativeBlocksChanged,
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
      const settled = next.then(
        () => undefined,
        () => undefined,
      );
      pending.set(params.sessionId, settled);
      // Drop the entry once this chain settles (unless a newer call already
      // replaced it) so long-lived servers don't leak one entry per session.
      void settled.then(() => {
        if (pending.get(params.sessionId) === settled) {
          pending.delete(params.sessionId);
        }
      });
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

function applyUpdatesToBlockSnapshot(
  blocks: readonly CoreMemoryBlock[],
  updates: ReadonlyMap<CoreMemoryLabel, string>,
): readonly CoreMemoryBlock[] {
  if (updates.size === 0) return blocks;
  return blocks.map((block) => {
    const content = updates.get(block.label);
    return content === undefined ? block : { ...block, content };
  });
}

const CONFIRMED_PROFILE_PREFIX = {
  zh: "角色资料（已确认）：",
  en: "Confirmed character profile: ",
} as const;

/**
 * Keep player-selected identity fields deterministic while leaving the LLM in
 * charge of the dynamic status prose that follows. Prompt priority alone is
 * insufficient here: a summarizer can translate or paraphrase an enum label
 * on a later turn, so the framework owns one canonical first line.
 */
function enforceAuthoritativePlayerProfile(args: {
  updates: Map<CoreMemoryLabel, string>;
  currentBlocks: readonly CoreMemoryBlock[];
  authoritativeFacts: MemoryAuthoritativeFacts | undefined;
  lang: "zh" | "en";
}): void {
  const { updates, currentBlocks, authoritativeFacts, lang } = args;
  const character = authoritativeFacts?.playerCharacter;
  if (
    !character ||
    (!updates.has("player_profile") &&
      !currentBlocks.some((block) => block.label === "player_profile"))
  ) {
    return;
  }

  const authoritativeLine = formatAuthoritativePlayerProfile(
    authoritativeFacts,
    lang,
  );
  if (!authoritativeLine) return;

  const currentContent =
    updates.get("player_profile") ??
    currentBlocks.find((block) => block.label === "player_profile")?.content ??
    "";
  const dynamicContent = stripProfileFactProse(
    stripManagedProfileLine(currentContent),
    authoritativeFacts,
    lang,
  );
  const nextContent = [authoritativeLine, dynamicContent]
    .filter(Boolean)
    .join("\n")
    .trim();

  const persistedContent =
    currentBlocks.find((block) => block.label === "player_profile")?.content ??
    "";
  if (
    updates.has("player_profile") ||
    nextContent !== persistedContent.trim()
  ) {
    updates.set("player_profile", nextContent);
  }
}

function formatAuthoritativePlayerProfile(
  facts: MemoryAuthoritativeFacts,
  lang: "zh" | "en",
): string | undefined {
  const character = facts.playerCharacter;
  if (!character?.name.trim()) return undefined;

  const parts = [
    lang === "zh"
      ? `姓名：${character.name.trim()}`
      : `Name: ${character.name.trim()}`,
  ];
  for (const [fieldId, rawValue] of Object.entries(character.fields ?? {})) {
    const value = formatAuthoritativeValue(rawValue);
    if (!value) continue;
    const label = facts.playerFieldLabels?.[fieldId]?.trim() || fieldId;
    parts.push(lang === "zh" ? `${label}：${value}` : `${label}: ${value}`);
  }

  const separator = lang === "zh" ? "；" : "; ";
  const terminator = lang === "zh" ? "。" : ".";
  return `${CONFIRMED_PROFILE_PREFIX[lang]}${parts.join(separator)}${terminator}`;
}

function formatAuthoritativeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every((item) => ["string", "number", "boolean"].includes(typeof item))
  ) {
    return value.map(String).join(", ");
  }
  return undefined;
}

function stripManagedProfileLine(content: string): string {
  const prefixes = Object.values(CONFIRMED_PROFILE_PREFIX);
  return content
    .split(/\r?\n/)
    .filter(
      (line) => !prefixes.some((prefix) => line.trim().startsWith(prefix)),
    )
    .join("\n")
    .trim();
}

function stripProfileFactProse(
  content: string,
  facts: MemoryAuthoritativeFacts,
  lang: "zh" | "en",
): string {
  if (!content) return "";

  const labels = Object.entries(facts.playerCharacter?.fields ?? {}).flatMap(
    ([fieldId]) =>
      [fieldId, facts.playerFieldLabels?.[fieldId]].filter(
        (value): value is string => Boolean(value?.trim()),
      ),
  );
  const values = Object.values(facts.playerCharacter?.fields ?? {})
    .map(formatAuthoritativeValue)
    .filter((value): value is string => Boolean(value && value.length >= 2));
  const identityPattern =
    lang === "zh" ? /(?:身份|姓名|名字)\s*[:：]/ : /(?:identity|name)\s*:/i;

  return content
    .split(/(?<=[。！？.!?])\s*|\r?\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      if (identityPattern.test(part)) return false;
      const labelMatches = labels.reduce(
        (count, label) => count + (part.includes(label) ? 1 : 0),
        0,
      );
      const valueMatches = values.reduce(
        (count, value) => count + (part.includes(value) ? 1 : 0),
        0,
      );
      return !(labelMatches >= 2 || valueMatches >= 1);
    })
    .join(lang === "zh" ? "" : " ")
    .trim();
}

function buildAuthoritativeFactsSection(
  facts: MemoryAuthoritativeFacts | undefined,
  lang: "zh" | "en",
): string {
  if (!facts || Object.keys(facts).length === 0) return "";

  try {
    const serialized = JSON.stringify(facts, null, 2);
    if (!serialized || serialized === "{}") return "";
    const bounded = serialized.slice(0, 4_000);
    return lang === "zh"
      ? `\n\n## 会话事实（权威）\n以下结构化值来自已提交的会话状态；发生冲突时以这些值为准。\n${bounded}`
      : `\n\n## Authoritative Session Facts\nThese structured values come from committed session state; use them whenever other context conflicts.\n${bounded}`;
  } catch {
    return "";
  }
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
