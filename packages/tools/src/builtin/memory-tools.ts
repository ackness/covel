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

export interface MemoryToolDeps {
  readonly recall: RecallSearcher;
  readonly archival: ArchivalSearcher;
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
      description: "搜索对话记忆和长期知识库。",
      parameters: z.object({
        query: z.string().min(1).describe("查询文本"),
        scope: z
          .enum(["recall", "archival", "all"])
          .optional()
          .describe("recall=对话，archival=知识库，all=全部（默认）"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("结果上限；默认 5"),
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

  return tools;
}
