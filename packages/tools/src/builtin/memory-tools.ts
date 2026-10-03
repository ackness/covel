import { z } from "zod";
import { tool } from "../tool.js";
import type { ToolModule } from "../types.js";

/** Narrow query boundary; memory owns tier selection and ranking. */
export interface MemoryToolDeps {
  search(
    sessionId: string,
    query: string,
    options: { scope: "recall" | "archival" | "all"; limit: number },
  ): Promise<
    readonly {
      source: string;
      content: string;
      role?: string;
      key?: string;
      score: number;
      timestamp?: string;
    }[]
  >;
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
        "Search conversation memory and the long-term knowledge base.",
      parameters: z.object({
        query: z.string().min(1).describe("Query text"),
        scope: z
          .enum(["recall", "archival", "all"])
          .optional()
          .describe(
            "recall = conversation, archival = knowledge base, all = both (default)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum results; default 5"),
      }),
      execute: async (params, context) => {
        const scope = params.scope ?? "all";
        const limit = params.limit ?? 5;
        const hits = await deps.search(context.sessionId, params.query, {
          scope,
          limit,
        });
        const results = hits.map((hit) => ({
          source: hit.source,
          ...(hit.key !== undefined ? { key: hit.key } : {}),
          content: (hit.source === "recall"
            ? `[${hit.role}] ${hit.content}`
            : hit.content
          ).slice(0, 500),
          score: hit.score,
          ...(hit.timestamp !== undefined ? { timestamp: hit.timestamp } : {}),
        }));

        return {
          query: params.query,
          scope,
          resultCount: results.length,
          results,
        };
      },
    }),
  );

  return tools;
}
