/**
 * Built-in memory tools — allow LLM runtimes to search conversation history,
 * read/write core memory blocks, and query archival knowledge.
 *
 * Inspired by Letta's memory tools:
 *   - conversation_search → memory-search (recall + archival)
 *   - core_memory_read    → memory-get-block
 *   - core_memory_replace → memory-update-block (restricted)
 */

import { z } from "zod";
import { tool } from "../tool.js";
import type { ToolModule } from "../types.js";

/** Minimal interface for recall search (avoids @covel/memory dependency). */
interface RecallSearcher {
	search(
		sessionId: string,
		query: string,
		limit?: number,
	): Promise<
		readonly {
			turnId: string;
			role: string;
			content: string;
			score: number;
			timestamp: string;
		}[]
	>;
}

/** Minimal interface for archival search. */
interface ArchivalSearcher {
	search(
		sessionId: string,
		query: string,
		limit?: number,
	): Promise<
		readonly {
			key: string;
			content: string;
			score: number;
			source: string;
			pluginId?: string;
		}[]
	>;
}

/** Minimal interface for core memory block access. */
interface MemoryBlockReader {
	getBlock(
		sessionId: string,
		label: string,
	): Promise<{ label: string; content: string; updatedAt: string } | null>;
	updateBlock(sessionId: string, label: string, content: string): Promise<void>;
}

export interface MemoryToolDeps {
	readonly recall: RecallSearcher;
	readonly archival: ArchivalSearcher;
	readonly blocks: MemoryBlockReader;
}

/**
 * Create memory-related builtin tools.
 * Returns an array of ToolModules ready for registration.
 */
export function createMemoryTools(deps: MemoryToolDeps): ToolModule[] {
	const tools: ToolModule[] = [];

	// ── memory-search ─────────────────────────────────────────────
	tools.push(
		tool({
			name: "memory-search",
			description:
				"搜索记忆。可搜索对话历史（recall）和长期知识库（archival，包括 codex 条目、lorebook、角色信息）。当你需要回忆之前发生的事件或查找世界设定时使用。",
			parameters: z.object({
				query: z.string().min(1).describe("搜索关键词或自然语言查询"),
				scope: z
					.enum(["recall", "archival", "all"])
					.optional()
					.describe(
						"搜索范围：recall=对话历史, archival=知识库, all=全部（默认）",
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(20)
					.optional()
					.describe("返回结果数量上限，默认 5"),
			}),
			execute: async (params, context) => {
				const scope = params.scope ?? "all";
				const limit = params.limit ?? 5;
				const results: Array<{
					source: string;
					key?: string;
					content: string;
					score: number;
					timestamp?: string;
				}> = [];

				if (scope === "recall" || scope === "all") {
					const recallResults = await deps.recall.search(
						context.sessionId,
						params.query,
						limit,
					);
					for (const r of recallResults) {
						results.push({
							source: "recall",
							content: `[${r.role}] ${r.content}`.slice(0, 500),
							score: r.score,
							timestamp: r.timestamp,
						});
					}
				}

				if (scope === "archival" || scope === "all") {
					const archivalResults = await deps.archival.search(
						context.sessionId,
						params.query,
						limit,
					);
					for (const r of archivalResults) {
						results.push({
							source: `archival:${r.source}`,
							key: r.key,
							content: r.content.slice(0, 500),
							score: r.score,
						});
					}
				}

				// Sort by score descending, take top N
				results.sort((a, b) => b.score - a.score);
				const top = results.slice(0, limit);

				return {
					query: params.query,
					scope,
					resultCount: top.length,
					results: top,
				};
			},
		}),
	);

	// ── memory-get-block ──────────────────────────────────────────
	tools.push(
		tool({
			name: "memory-get-block",
			description:
				"读取一个核心记忆块的内容。可用的块：story_state（剧情状态）、scene（当前场景）、character_relationships（角色关系）、player_profile（玩家状态）。",
			parameters: z.object({
				label: z
					.enum([
						"story_state",
						"scene",
						"character_relationships",
						"player_profile",
					])
					.describe("记忆块标签"),
			}),
			execute: async (params, context) => {
				const block = await deps.blocks.getBlock(
					context.sessionId,
					params.label,
				);
				if (!block) {
					return { found: false, label: params.label, content: "" };
				}
				return {
					found: true,
					label: block.label,
					content: block.content,
					updatedAt: block.updatedAt,
				};
			},
		}),
	);

	// ── memory-update-block ───────────────────────────────────────
	// Restricted: only runtimes with 'memory-write' capability can use this.
	// The tool scoping system handles access control.
	tools.push(
		tool({
			name: "memory-update-block",
			description:
				"更新一个核心记忆块。使用此工具记录重要的剧情进展、场景变化或角色关系变化。内容应是完整的替换文本（不是增量），300-500 字以内。",
			parameters: z.object({
				label: z
					.enum([
						"story_state",
						"scene",
						"character_relationships",
						"player_profile",
					])
					.describe("要更新的记忆块标签"),
				content: z
					.string()
					.min(1)
					.max(2000)
					.describe("完整的新内容（替换旧内容）"),
			}),
			execute: async (params, context) => {
				await deps.blocks.updateBlock(
					context.sessionId,
					params.label,
					params.content,
				);
				return {
					updated: true,
					label: params.label,
					contentLength: params.content.length,
				};
			},
		}),
	);

	return tools;
}
