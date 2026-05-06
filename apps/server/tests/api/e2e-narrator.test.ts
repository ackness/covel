/**
 * E2E test: Complete narrator game flow through the API.
 *
 * Flow:
 *   POST /api/sessions           → create session, activate narrator
 *   POST /api/sessions/:id/turn  → execute turn with narrator
 *   store assertions             → verify narrative output and turn history
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import type { Hono } from "hono";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore } from "@covel/store";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";

// ── Mock LLM that returns narrative text ─────────────────────────

class MockNarratorLLM implements LLMAdapter {
	callCount = 0;
	lastMessages: Array<{ role: string; content: string }> = [];
	allMessages: Array<readonly { role: string; content: string }[]> = [];

	async generate(params: {
		messages: readonly { role: string; content: string }[];
	}): Promise<LLMResponse> {
		this.callCount++;
		this.lastMessages = [...params.messages];
		this.allMessages.push([...params.messages]);

		// Find the player message to echo back — use the LAST user turn so
		// seed messages from the turn-band bootstrap don't shadow the current
		// player action.
		const userMsgs = params.messages.filter((m) => m.role === "user");
		const userMsg = userMsgs[userMsgs.length - 1];
		const playerAction = userMsg?.content ?? "未知操作";

		return {
			content: `你${playerAction}。空气中弥漫着潮湿的泥土气息，远处传来隐约的脚步声。你紧握手中的武器，警惕地环顾四周。一道微弱的光芒从前方的裂缝中透出，似乎在引导你前行。`,
			toolCalls: [],
			finishReason: "stop",
			usage: { inputTokens: 200, outputTokens: 80 },
		};
	}
}

// ── Tests ─────────────────────────────────────────────────────────

describe("E2E: Narrator game flow", () => {
	let app: Hono;
	let mockLLM: MockNarratorLLM;
	let store: Awaited<ReturnType<typeof bootstrapApi>>["store"];

	const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../../plugins");

	beforeAll(async () => {
		mockLLM = new MockNarratorLLM();
		const result = await bootstrapApi({
			pluginsDir: PLUGINS_DIR,
			llmAdapter: mockLLM,
			store: createMemoryStore(),
			storeBackend: "memory",
		});
		app = result.app;
		store = result.store;

		// Activate narrator for all sessions globally
		result.registry.activate("narrator", "__global__");
	});

	async function markPreGameComplete(sessionId: string) {
		await store.updateSession(sessionId, {
			preGameCompleted: [
				"pregame",
				"world-init/schema-gen",
				"char-creator/player-init",
			],
			turnCount: 1,
			updatedAt: new Date().toISOString(),
		});
	}

	it("should complete a full game turn through the API", async () => {
		// 1. Create session
		const startRes = await app.request("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ locale: "zh-CN", plugins: ["narrator"] }),
		});
		expect(startRes.status).toBe(200);

		const session = (await startRes.json()) as {
			id: string;
			status: string;
			turnCount: number;
		};
		expect(session.id).toBeDefined();
		expect(session.status).toBe("active");
		expect(session.turnCount).toBe(0);

		const sessionId = session.id;

		await markPreGameComplete(sessionId);

		// 2. Execute a turn
		const turnRes = await app.request(`/api/sessions/${sessionId}/turn`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "走进了黑暗的森林" }),
		});
		expect(turnRes.status).toBe(200);

		const turnBody = (await turnRes.json()) as {
			turnId: string;
			runtimeResults: Array<{
				pluginId: string;
				status: string;
				output: { narrativeOutput?: string };
			}>;
		};

		expect(turnBody.turnId).toBeDefined();

		const narratorResult = turnBody.runtimeResults.find(
			(result) => result.pluginId === "narrator",
		);
		expect(narratorResult).toBeDefined();
		expect(narratorResult!.pluginId).toBe("narrator");
		expect(narratorResult!.status).toBe("success");
		expect(narratorResult!.output.narrativeOutput).toContain(
			"走进了黑暗的森林",
		);
		expect(narratorResult!.output.narrativeOutput).toContain("泥土气息");

		// 3. Verify LLM was called with correct context
		expect(mockLLM.callCount).toBeGreaterThanOrEqual(1);
		const narratorMessages = mockLLM.allMessages.find((messages) =>
			messages.some((m) => m.role === "system" && m.content.includes("叙述者")),
		);
		const systemMsg = narratorMessages?.find((m) => m.role === "system");
		expect(systemMsg).toBeDefined();
		// System prompt should contain the PLUGIN.md template with player message interpolated
		expect(systemMsg!.content).toContain("叙述者");
		expect(systemMsg!.content).toContain("走进了黑暗的森林");
	});

	it("should handle multiple turns in sequence", async () => {
		// Create session
		const startRes = await app.request("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plugins: ["narrator"] }),
		});
		const session = (await startRes.json()) as { id: string };

		await markPreGameComplete(session.id);

		// Turn 1
		const turn1Res = await app.request(`/api/sessions/${session.id}/turn`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "拔出长剑" }),
		});
		expect(turn1Res.status).toBe(200);

		// Turn 2
		const turn2Res = await app.request(`/api/sessions/${session.id}/turn`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "向巨龙发起攻击" }),
		});
		expect(turn2Res.status).toBe(200);
	});

	it("should return 404 for turn on non-existent session", async () => {
		const res = await app.request("/api/sessions/nonexistent/turn", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "test" }),
		});
		expect(res.status).toBe(404);
	});

	it("should list narrator in plugins", async () => {
		const res = await app.request("/api/plugins");
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			plugins: Array<{ id: string; pluginType: string }>;
		};
		const narrator = body.plugins.find((p) => p.id === "narrator");
		expect(narrator).toBeDefined();
		expect(narrator!.pluginType).toBe("core-plugin");
	});

	it("should health check", async () => {
		const res = await app.request("/api/health");
		expect(res.status).toBe(200);

		const body = (await res.json()) as { status: string };
		expect(body.status).toBe("ok");
	});
});
