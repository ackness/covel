/**
 * npc-graph/rag-retriever — function handler tests.
 *
 * Seeds the same in-memory mock store with deterministic nodes/edges,
 * then drives the function handler with various playerMessage inputs
 * to assert:
 *
 *   1. Empty graph short-circuits to empty context
 *   2. Player message that matches no node returns empty context
 *   3. Player message naming a node returns its 1-hop facts
 *   4. 2-hop expansion follows the adjacency index
 *   5. Markdown formatting includes the strength sign and relation
 *   6. Aliases are matched case-insensitively
 */

import { describe, it, expect, beforeEach } from "vitest";
import handler from "../runtimes/rag-retriever/handler.js";

function createMockStore() {
	/** @type {Map<string, any>} */
	const data = new Map();
	const makeKey = (sid, pid, ns, k) => `${sid}:${pid}:${ns}:${k}`;
	return {
		data,
		async setPluginData(record) {
			data.set(
				makeKey(
					record.sessionId,
					record.pluginId,
					record.namespace,
					record.key,
				),
				{
					namespace: record.namespace,
					key: record.key,
					value: record.value,
				},
			);
		},
		async setPluginDataBatch(records) {
			for (const r of records) await this.setPluginData(r);
		},
		async getPluginData(sessionId, pluginId, namespace, key) {
			return data.get(makeKey(sessionId, pluginId, namespace, key)) ?? null;
		},
		async listPluginData(sessionId, pluginId, namespace) {
			const prefix = namespace
				? `${sessionId}:${pluginId}:${namespace}:`
				: `${sessionId}:${pluginId}:`;
			const out = [];
			for (const [k, v] of data) {
				if (k.startsWith(prefix)) out.push(v);
			}
			return out;
		},
	};
}

const SESSION = "sess-rag";
const PLUGIN = "npc-graph";

/**
 * Seed a small graph:
 *
 *   alice ──TRUSTS+0.8──> bob
 *   bob   ──FEARS-0.6──> charlie
 *   charlie ──ALLY_OF+0.5──> dave
 *
 * Player message "alice spoke quietly" should retrieve:
 *   - 1-hop: alice→bob
 *   - 2-hop: bob→charlie
 * (charlie→dave is 3 hops away, excluded.)
 */
async function seedSmallChain(store) {
	const baseRecord = {
		id: "_",
		sessionId: SESSION,
		pluginId: PLUGIN,
		createdAt: "now",
		updatedAt: "now",
	};
	await store.setPluginDataBatch([
		{
			...baseRecord,
			namespace: "nodes",
			key: "npc-alice",
			value: {
				id: "npc-alice",
				name: "Alice",
				aliases: ["Ali"],
				type: "individual",
				labels: [],
				summary: "A merchant from the eastern quarter.",
				firstSeenTurn: 0,
				lastSeenTurn: 1,
			},
		},
		{
			...baseRecord,
			namespace: "nodes",
			key: "npc-bob",
			value: {
				id: "npc-bob",
				name: "Bob",
				type: "individual",
				labels: [],
				summary: "Alice's longtime business partner.",
				firstSeenTurn: 0,
				lastSeenTurn: 1,
			},
		},
		{
			...baseRecord,
			namespace: "nodes",
			key: "npc-charlie",
			value: {
				id: "npc-charlie",
				name: "Charlie",
				type: "individual",
				labels: [],
				summary: "A guard captain who once arrested Bob.",
				firstSeenTurn: 0,
				lastSeenTurn: 1,
			},
		},
		{
			...baseRecord,
			namespace: "nodes",
			key: "npc-dave",
			value: {
				id: "npc-dave",
				name: "Dave",
				type: "individual",
				labels: [],
				summary: "Charlie's lieutenant.",
				firstSeenTurn: 0,
				lastSeenTurn: 1,
			},
		},
		{
			...baseRecord,
			namespace: "edges",
			key: "edge-1",
			value: {
				id: "edge-1",
				source: "npc-alice",
				target: "npc-bob",
				relation: "TRUSTS",
				strength: 0.8,
				fact: "Alice has trusted Bob since they survived a sandstorm together.",
				validAt: 0,
				evidenceTurnIds: ["turn-0"],
			},
		},
		{
			...baseRecord,
			namespace: "edges",
			key: "edge-2",
			value: {
				id: "edge-2",
				source: "npc-bob",
				target: "npc-charlie",
				relation: "FEARS",
				strength: -0.6,
				fact: "Bob fears Charlie ever since the night raid in the lower district.",
				validAt: 1,
				evidenceTurnIds: ["turn-1"],
			},
		},
		{
			...baseRecord,
			namespace: "edges",
			key: "edge-3",
			value: {
				id: "edge-3",
				source: "npc-charlie",
				target: "npc-dave",
				relation: "ALLY_OF",
				strength: 0.5,
				fact: "Charlie has worked alongside Dave for many years.",
				validAt: 2,
				evidenceTurnIds: ["turn-2"],
			},
		},
		// Adjacency index
		{
			...baseRecord,
			namespace: "index",
			key: "by-source:npc-alice",
			value: ["edge-1"],
		},
		{
			...baseRecord,
			namespace: "index",
			key: "by-target:npc-bob",
			value: ["edge-1"],
		},
		{
			...baseRecord,
			namespace: "index",
			key: "by-source:npc-bob",
			value: ["edge-2"],
		},
		{
			...baseRecord,
			namespace: "index",
			key: "by-target:npc-charlie",
			value: ["edge-2"],
		},
		{
			...baseRecord,
			namespace: "index",
			key: "by-source:npc-charlie",
			value: ["edge-3"],
		},
		{
			...baseRecord,
			namespace: "index",
			key: "by-target:npc-dave",
			value: ["edge-3"],
		},
	]);
}

function makeCtx(store, playerMessage) {
	return {
		sessionId: SESSION,
		turnId: "turn-3",
		pluginId: "npc-graph",
		playerMessage,
		locale: "zh-CN",
		store,
		completedResults: new Map(),
		config: {},
	};
}

describe("rag-retriever handler", () => {
	let store;

	beforeEach(() => {
		store = createMockStore();
	});

	it("returns empty context when the graph is empty", async () => {
		const result = await handler(
			makeCtx(store, "Alice walked into the tavern."),
		);
		expect(result.npcContext).toBe("");
		expect(result.matchedNodes).toEqual([]);
		expect(result.edgeCount).toBe(0);
	});

	it("returns empty context when no node name matches the player message", async () => {
		await seedSmallChain(store);
		const result = await handler(
			makeCtx(store, "You wander through an empty courtyard."),
		);
		expect(result.npcContext).toBe("");
		expect(result.matchedNodes).toEqual([]);
	});

	it("retrieves 1-hop facts when a node name matches", async () => {
		await seedSmallChain(store);
		const result = await handler(
			makeCtx(store, "You greet Alice at the market."),
		);
		expect(result.npcContext).toContain("Alice");
		expect(result.npcContext).toContain("Bob");
		expect(result.npcContext).toContain("TRUSTS");
		expect(result.matchedNodes).toContain("npc-alice");
		// 1-hop expansion brings in Bob
		expect(result.matchedNodes).toContain("npc-bob");
	});

	it("expands 2 hops to surface neighbour-of-neighbour edges", async () => {
		await seedSmallChain(store);
		const result = await handler(
			makeCtx(store, "You greet Alice at the market."),
		);
		// Alice → Bob (1-hop) → Charlie (2-hop)
		expect(result.npcContext).toContain("Charlie");
		expect(result.npcContext).toContain("FEARS");
		expect(result.matchedNodes).toContain("npc-charlie");
		// Dave is 3-hop, must NOT appear
		expect(result.matchedNodes).not.toContain("npc-dave");
		expect(result.npcContext).not.toContain("Dave");
	});

	it("marks positive strengths with [+] and negative with [-]", async () => {
		await seedSmallChain(store);
		const result = await handler(
			makeCtx(store, "You greet Alice at the market."),
		);
		expect(result.npcContext).toMatch(/\[\+\].*Alice.*Bob.*TRUSTS/);
		expect(result.npcContext).toMatch(/\[-\].*Bob.*Charlie.*FEARS/);
	});

	it("matches aliases case-insensitively", async () => {
		await seedSmallChain(store);
		const result = await handler(makeCtx(store, "ali wandered off again"));
		expect(result.matchedNodes).toContain("npc-alice");
		expect(result.npcContext).toContain("Alice");
	});

	it("emits a header section when at least one fact is found", async () => {
		await seedSmallChain(store);
		const result = await handler(makeCtx(store, "Alice…"));
		expect(result.npcContext).toMatch(/^## 已知 NPC 关系/);
	});
});
