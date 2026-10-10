/**
 * Plugin-local tool: list-npc-graph
 *
 * Returns a compact summary of nodes and edges already registered in the
 * current session, so the LLM can avoid creating duplicates and instead
 * extend existing nodes / relationships.
 *
 * @param {{ tool: Function, z: import('zod') }} injection
 */
export default function ({ tool, z }) {
  return tool({
    name: "list-npc-graph",
    description:
      "List the NPC nodes and relationship edges already registered in the current session, to help tell which are newly introduced and which are already known. Returns each node's name/type/labels/summary plus the fact of every current edge. Nodes (most recently seen first) and edges (most recently changed first) are capped, and the result says when it cut a list.",
    parameters: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe(
          "Maximum number of records to return (default 120; also truncated internally)",
        ),
    }),
    execute: async (params, context) => {
      const limit = Math.min(params.limit ?? 120, 200);

      const nodeRows = (await context.store.listPluginData("nodes")) ?? [];
      const edgeRows = (await context.store.listPluginData("edges")) ?? [];

      // Newest first, like the edges: when the cap cuts the list, the people
      // who just appeared are the ones the model must not miss.
      const recentNodeRows = [...nodeRows].sort(
        (a, b) => (b.value?.lastSeenTurn ?? -1) - (a.value?.lastSeenTurn ?? -1),
      );

      const nodes = recentNodeRows.slice(0, limit).map((row) => {
        const value =
          /** @type {{ id: string, name: string, type: string, labels: string[], summary: string, lastSeenTurn: number }} */ (
            row.value ?? {}
          );
        return {
          id: value.id,
          name: value.name,
          type: value.type,
          labels: value.labels,
          summary: value.summary,
          lastSeenTurn: value.lastSeenTurn,
        };
      });

      // Superseded versions stay in storage as history; the model needs the
      // current relationships, newest first when the cap cuts the list.
      const openEdgeRows = edgeRows
        .filter((row) => row.value?.invalidAt === undefined)
        .sort((a, b) => (b.value?.validAt ?? -1) - (a.value?.validAt ?? -1));

      const edges = openEdgeRows.slice(0, limit).map((row) => {
        const value =
          /** @type {{ id: string, source: string, target: string, relation: string, strength: number, fact: string, validAt: number, invalidAt?: number }} */ (
            row.value ?? {}
          );
        return {
          id: value.id,
          source: value.source,
          target: value.target,
          relation: value.relation,
          strength: value.strength,
          fact: value.fact,
          validAt: value.validAt,
          invalidAt: value.invalidAt,
        };
      });

      return {
        nodeCount: nodeRows.length,
        edgeCount: openEdgeRows.length,
        nodes,
        edges,
        ...(nodeRows.length > nodes.length
          ? {
              nodesTruncated: `Showing the ${nodes.length} most recently seen of ${nodeRows.length} nodes.`,
            }
          : {}),
        ...(openEdgeRows.length > edges.length
          ? {
              edgesTruncated: `Showing the ${edges.length} most recently changed of ${openEdgeRows.length} current edges.`,
            }
          : {}),
      };
    },
  });
}
