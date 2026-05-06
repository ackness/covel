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
 * Inspired by Letta's `memory_rethink` tool, but framework-controlled
 * rather than free-form LLM editing.
 */

import type {
	CoreMemoryBlock,
	CoreMemoryLabel,
	MemoryLLMAdapter,
	MemoryManager,
	MemoryUpdateResult,
	MemoryUpdaterConfig,
} from "./types.js";
import { CORE_MEMORY_LABELS } from "./types.js";

const SYSTEM_PROMPT_ZH = `你是一个记忆管理器。你的任务是根据本轮新发生的故事事件，更新游戏的核心记忆块。

## 记忆块说明

- **story_state**：主线剧情摘要、已揭示的秘密、未解决的悬念、已完成的关键事件
- **scene**：当前场景位置、时间、氛围、环境描写要点
- **character_relationships**：关键 NPC 与玩家的关系状态、态度变化、重要对话
- **player_profile**：玩家角色当前状态摘要（等级、装备、能力、当前目标）

## 输出格式

只输出一个 JSON 对象，key 是需要更新的块标签，value 是**完整的新内容**（不是增量）。
只输出有变化的块。如果本轮没有值得更新的信息，输出 \`{}\`。

每个块内容控制在 300-500 字以内，使用简洁的事实陈述，不要用文学化的描写。

示例输出：
\`\`\`json
{
  "scene": "青萍宗外门坊市西侧巷子里的废弃灵植仓库。午后，光线昏暗。苏婉正在向玩家展示百灵沼泽的兽皮地图。",
  "story_state": "主线：苏婉发现百灵沼泽深处有未登记的二等灵脉，灵脉旁有不明古代结构在吸收灵气。她邀请玩家在试炼大会前同去探查。\\n悬念：古代结构的来源和目的不明。陆沉渊在研究未知阵法。"
}
\`\`\``;

const SYSTEM_PROMPT_EN = `You are a memory manager. Your task is to update the game's core memory blocks based on new story events from the current turn.

## Memory Block Descriptions

- **story_state**: Main plot summary, revealed secrets, unresolved threads, key completed events
- **scene**: Current location, time, atmosphere, key environmental details
- **character_relationships**: Key NPC relationships with the player, attitude changes, important conversations
- **player_profile**: Player character current status summary (level, equipment, abilities, current objectives)

## Output Format

Output a single JSON object where keys are block labels that need updating and values are the **complete new content** (not incremental).
Only output blocks that changed. If nothing worth updating happened, output \`{}\`.

Keep each block under 300-500 words. Use concise factual statements, not literary descriptions.`;

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
		const lang = (locale ?? resolvedLocale).startsWith("zh") ? "zh" : "en";

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
				systemPrompt: lang === "zh" ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN,
				messages: [{ role: "user", content: userPrompt }],
				model: config?.modelSlot,
			});

			const parsed = parseBlockUpdates(response.content);
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
 */
function parseBlockUpdates(raw: string): Map<CoreMemoryLabel, string> {
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
	const validLabels = new Set<string>(CORE_MEMORY_LABELS);
	for (const [key, value] of Object.entries(obj)) {
		if (validLabels.has(key) && typeof value === "string" && value.trim()) {
			result.set(key as CoreMemoryLabel, value.trim());
		}
	}

	return result;
}
