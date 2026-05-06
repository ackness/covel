/**
 * Compactor — Summarize old messages and update core memory blocks.
 *
 * Inspired by Letta's compaction mechanism:
 *   1. When message count exceeds a sliding window threshold, partition into
 *      "to-compact" prefix + protected tail.
 *   2. Call the memory-slot LLM to generate a summary of the compacted messages.
 *   3. Store the summary in session_summaries.
 *   4. Tag the original messages so prompt-build substitutes the summary.
 *   5. Simultaneously update core memory blocks with key info from compacted messages.
 *
 * Original messages are NEVER deleted, only tagged.
 */

import type { DataStore } from "@covel/store";
import type {
	CompactionConfig,
	CompactionResult,
	CoreMemoryBlock,
	MemoryLLMAdapter,
	MemoryManager,
} from "./types.js";

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_PROTECT_USER_TURNS = 2;
const DEFAULT_PROTECT_TAIL = 5;

const COMPACTION_SYSTEM_PROMPT_ZH = `你是一个故事摘要生成器。请将以下对话历史压缩成一段简洁的摘要。

要求：
- 保留所有关键事件、人物动作、重要对话
- 保留地点变化和时间线索
- 丢弃重复描写、环境装饰、过渡性对话
- 使用第三人称过去式
- 300-500 字`;

const COMPACTION_SYSTEM_PROMPT_EN = `You are a story summary generator. Compress the following conversation history into a concise summary.

Requirements:
- Preserve all key events, character actions, important dialogue
- Preserve location changes and timeline markers
- Discard repetitive descriptions, environmental decoration, transitional dialogue
- Use third-person past tense
- 300-500 words`;

export interface CompactorDeps {
	readonly store: DataStore;
	readonly llm: MemoryLLMAdapter;
	readonly memoryManager: MemoryManager;
}

export function createCompactor(
	deps: CompactorDeps,
	config?: CompactionConfig,
) {
	const threshold = config?.threshold ?? DEFAULT_THRESHOLD;
	const protectUserTurns =
		config?.protectLastNUserTurns ?? DEFAULT_PROTECT_USER_TURNS;
	const protectTail = config?.protectLastNMessages ?? DEFAULT_PROTECT_TAIL;
	const locale = config?.locale ?? "zh-CN";

	return {
		async compact(params: {
			sessionId: string;
			estimatedTokens: number;
			contextWindow: number;
			messages: readonly {
				id: string;
				role: string;
				content: string;
				turnId?: string;
				createdAt: string;
			}[];
		}): Promise<CompactionResult> {
			const { sessionId, estimatedTokens, contextWindow, messages } = params;

			// Check if compaction is needed
			if (estimatedTokens < contextWindow * threshold) {
				return {
					compacted: false,
					messagesBefore: messages.length,
					messagesAfter: messages.length,
				};
			}

			if (messages.length <= protectTail) {
				return {
					compacted: false,
					messagesBefore: messages.length,
					messagesAfter: messages.length,
				};
			}

			// Partition: find the protection boundary
			// Protect the last N user turns + last N messages overall
			let protectFrom = messages.length - protectTail;

			// Walk backward to find the Nth user message
			let userTurnsSeen = 0;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "user") {
					userTurnsSeen++;
					if (userTurnsSeen >= protectUserTurns) {
						protectFrom = Math.min(protectFrom, i);
						break;
					}
				}
			}

			// At least 3 messages to compact (otherwise not worth it)
			if (protectFrom < 3) {
				return {
					compacted: false,
					messagesBefore: messages.length,
					messagesAfter: messages.length,
				};
			}

			const toCompact = messages.slice(0, protectFrom);
			const toKeep = messages.slice(protectFrom);

			// Build compaction input
			const historyText = toCompact
				.map((m) => `[${m.role}] ${m.content}`)
				.join("\n\n");

			const lang = locale.startsWith("zh") ? "zh" : "en";

			try {
				// Generate summary
				const response = await deps.llm.complete({
					systemPrompt:
						lang === "zh"
							? COMPACTION_SYSTEM_PROMPT_ZH
							: COMPACTION_SYSTEM_PROMPT_EN,
					messages: [{ role: "user", content: historyText }],
					model: config?.modelSlot,
				});

				const summary = response.content.trim();
				const summaryId = `summary-${Date.now()}`;
				const now = new Date().toISOString();

				// Persist summary
				await deps.store.saveSessionSummary({
					id: summaryId,
					sessionId,
					turnRangeStart: toCompact[0].turnId ?? toCompact[0].id,
					turnRangeEnd:
						toCompact[toCompact.length - 1].turnId ??
						toCompact[toCompact.length - 1].id,
					content: summary,
					focusSections: [],
					createdAt: now,
				});

				// Tag compacted messages (mark them so prompt-build can skip them)
				const compactedIds = toCompact.map((m) => m.id);
				await deps.store.tagTurnMessagesCompacted(
					sessionId,
					compactedIds,
					summaryId,
				);

				// Also trigger a core memory block refresh with the compacted info
				// so key facts survive the compaction
				try {
					const currentBlocks = await deps.memoryManager.loadBlocks(sessionId);
					const { createMemoryUpdater } = await import("./updater.js");
					const updater = createMemoryUpdater(deps.memoryManager, deps.llm, {
						modelSlot: config?.modelSlot,
						locale,
					});
					await updater.updateAfterTurn({
						sessionId,
						narrativeText: summary,
						currentBlocks,
						locale,
					});
				} catch {
					// Non-fatal: memory update during compaction is best-effort
				}

				return {
					compacted: true,
					summaryId,
					messagesBefore: messages.length,
					messagesAfter: toKeep.length,
					summary,
				};
			} catch (err) {
				// Compaction failure is non-fatal — keep full history
				return {
					compacted: false,
					messagesBefore: messages.length,
					messagesAfter: messages.length,
				};
			}
		},
	};
}
