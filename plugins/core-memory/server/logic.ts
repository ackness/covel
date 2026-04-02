/**
 * Pure business logic for the core-memory plugin.
 * All functions are side-effect-free and testable without LLM access.
 */

// ── Types ───────────────────────────────────────────────────────

export interface MemoryArchive {
  readonly summary: string;
  readonly version: number;
  readonly lastTurnId?: string;
}

export interface ParsedSummaryResponse {
  readonly summary: string;
  readonly keyEvents: readonly string[];
}

export interface MemoryProposal {
  readonly kind: string;
  readonly payload: unknown;
}

// ── Prompt Building ─────────────────────────────────────────────

/**
 * Build the LLM prompt for generating a rolling summary.
 * Combines existing summary, new narrative, and recent events into
 * a structured prompt that instructs the LLM to produce JSON output.
 */
export function buildSummaryPrompt(
  narrative: string,
  existingSummary: string | undefined,
  events: ReadonlyArray<{ readonly type?: string; readonly payload?: unknown }>,
  locale: string
): string {
  const isZh = locale.startsWith("zh");

  const eventLines = events
    .map((e) => {
      const type = e.type ?? "unknown";
      const detail =
        typeof e.payload === "string"
          ? e.payload
          : JSON.stringify(e.payload ?? {});
      return `- [${type}] ${detail}`;
    })
    .join("\n");

  if (isZh) {
    return `你是一个RPG游戏的记忆管理者。你的任务是将叙事历史压缩成滚动摘要。

## 现有摘要
${existingSummary ? existingSummary : "（无，这是首次摘要）"}

## 新叙事内容
${narrative || "（无新叙事）"}

## 近期事件
${eventLines || "（无近期事件）"}

## 要求
1. 将现有摘要与新内容合并为一份更新的滚动摘要
2. 保留关键事实：角色名、地点、关系、目标、物品
3. 保留关键剧情事件和转折点
4. 去除填充内容、重复描述和机械细节
5. 摘要控制在300-500字以内
6. 用第三人称、过去时、以事实编年的方式书写
7. 用中文撰写
8. 识别0-3个值得单独存储的"关键事件"

## 输出格式
返回有效的JSON：
\`\`\`json
{
  "summary": "更新后的滚动摘要...",
  "keyEvents": ["关键事件1的描述", "关键事件2的描述"]
}
\`\`\`
只输出JSON，不要输出其他内容。`;
  }

  return `You are a memory manager for an RPG game. Your task is to compress narrative history into a rolling summary.

## Existing Summary
${existingSummary ? existingSummary : "(None — this is the first summary)"}

## New Narrative Content
${narrative || "(No new narrative)"}

## Recent Events
${eventLines || "(No recent events)"}

## Requirements
1. Merge the existing summary with new content into an updated rolling summary
2. Preserve key facts: character names, locations, relationships, goals, items
3. Preserve plot-critical events and turning points
4. Drop filler, repetitive descriptions, and mechanical details
5. Keep the summary to 300-500 words maximum
6. Write in third person, past tense, as a factual chronicle
7. Write in English
8. Identify 0-3 "key events" worth storing individually

## Output Format
Return valid JSON:
\`\`\`json
{
  "summary": "Updated rolling summary text...",
  "keyEvents": ["Description of key event 1", "Description of key event 2"]
}
\`\`\`
Output only JSON, nothing else.`;
}

// ── Response Parsing ────────────────────────────────────────────

/**
 * Parse the LLM response into a structured summary result.
 * Tolerates markdown code fences, extra whitespace, and partial JSON.
 */
export function parseSummaryResponse(response: string): ParsedSummaryResponse {
  const trimmed = response.trim();

  // Strip markdown code fences if present
  const jsonStr = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  try {
    const parsed: unknown = JSON.parse(jsonStr);

    if (typeof parsed !== "object" || parsed === null) {
      return { summary: trimmed, keyEvents: [] };
    }

    const obj = parsed as Record<string, unknown>;
    const summary =
      typeof obj.summary === "string" ? obj.summary.trim() : trimmed;
    const keyEvents = Array.isArray(obj.keyEvents)
      ? obj.keyEvents.filter((e): e is string => typeof e === "string")
      : [];

    return { summary, keyEvents };
  } catch {
    // If JSON parsing fails, treat the entire response as the summary
    return { summary: trimmed, keyEvents: [] };
  }
}

// ── Proposal Building ───────────────────────────────────────────

/**
 * Build the kernel proposals from a parsed summary response.
 * Emits a state.patch for the rolling summary and record.upsert entries
 * for each key event.
 */
export function buildMemoryProposals(
  parsed: ParsedSummaryResponse,
  turnId: string,
  currentVersion: number
): readonly MemoryProposal[] {
  const nextVersion = currentVersion + 1;

  const proposals: MemoryProposal[] = [
    {
      kind: "state.patch",
      payload: {
        memoryArchive: {
          summary: parsed.summary,
          version: nextVersion,
          lastTurnId: turnId,
        } satisfies MemoryArchive,
      },
    },
  ];

  for (const event of parsed.keyEvents) {
    proposals.push({
      kind: "record.upsert",
      payload: {
        type: "memory.key_event",
        turnId,
        version: nextVersion,
        content: event,
      },
    });
  }

  return proposals;
}

// ── Context Formatting ──────────────────────────────────────────

/**
 * Format a memory archive for injection into runtime context.
 * Returns a human-readable summary string suitable for LLM consumption.
 */
export function formatMemoryContext(archive: unknown): string {
  if (
    typeof archive !== "object" ||
    archive === null ||
    !("summary" in archive)
  ) {
    return "";
  }

  const obj = archive as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" ? obj.summary.trim() : "";
  const version =
    typeof obj.version === "number" ? obj.version : 0;

  if (!summary) {
    return "";
  }

  return `[Memory Archive v${version}]\n${summary}`;
}
