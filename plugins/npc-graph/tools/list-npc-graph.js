/**
 * Plugin-local tool: list-npc-graph
 *
 * Returns a compact summary of nodes and edges already registered in the
 * current session, so the LLM can avoid creating duplicates and instead
 * extend existing nodes / relationships.
 *
 * @param {{ tool: Function, z: import('zod'), store: any }} injection
 */
export default function ({ tool, z, store }) {
  return tool({
    name: "list-npc-graph",
    description:
      "List the NPC nodes and relationship edges already registered in the current session, to help tell which are newly introduced and which are already known. Returns each node's name/type/labels/summary plus the fact of every edge.",
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

      const nodeRows =
        (await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "nodes",
        )) ?? [];
      const edgeRows =
        (await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "edges",
        )) ?? [];

      const nodes = nodeRows.slice(0, limit).map((row) => {
        const value = /** @type {import('@covel/shared').NpcNode} */ (
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

      const edges = edgeRows.slice(0, limit).map((row) => {
        const value = /** @type {import('@covel/shared').NpcEdge} */ (
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
        edgeCount: edgeRows.length,
        nodes,
        edges,
      };
    },
  });
}
