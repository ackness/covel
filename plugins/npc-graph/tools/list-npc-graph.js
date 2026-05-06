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
			"列出当前会话已登记的 NPC 节点和关系边，帮助判断哪些是新出现的、哪些是已知的。返回节点的 name/type/labels/summary 摘要以及所有边的 fact。",
		parameters: z.object({
			limit: z
				.number()
				.int()
				.positive()
				.max(200)
				.optional()
				.describe("最多返回多少条（默认 120，内部也会截断）"),
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
