/**
 * ToolExecutor + ApprovalPipeline integration tests.
 *
 * Verifies:
 * 1. Whitelisted tools (builtin + known local) execute without approval
 * 2. Unknown tools are denied by default
 * 3. approvalStatus is correctly recorded in store
 * 4. Backward compatibility: no approval pipeline = auto-allow all (legacy)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createToolExecutor } from "../src/tool-executor.js";
import type {
	ToolCall,
	ToolCallContext,
	ToolExecutor,
} from "../src/tool-executor.js";
import { createApprovalPipeline } from "@covel/approval";
import type { PermissionRule } from "@covel/approval";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { tool } from "@covel/tools";
import { z } from "zod";

// ── Test tools ──────────────────────────────────────────────────

const echoTool = tool({
	name: "echo",
	description: "Echo back the input",
	parameters: z.object({ message: z.string() }),
	execute: async (params) => ({ echoed: params.message }),
});

const dangerousTool = tool({
	name: "dangerous-action",
	description: "A hypothetical dangerous tool",
	parameters: z.object({ target: z.string() }),
	execute: async (params) => ({ deleted: params.target }),
});

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
	return { toolCallId: `call-${name}`, name, arguments: JSON.stringify(args) };
}

const ctx: ToolCallContext = {
	sessionId: "sess-1",
	turnId: "turn-1",
	pluginId: "test-plugin",
	runtimeId: "test-rt",
};

// ── Tests ───────────────────────────────────────────────────────

describe("ToolExecutor with ApprovalPipeline", () => {
	let store: DataStore;

	beforeEach(() => {
		store = createMemoryStore();
	});

	describe("whitelist strategy: builtin + local allowed, unknown denied", () => {
		const rules: readonly PermissionRule[] = [
			{ pattern: "builtin:*", action: "allow" },
			{ pattern: "local:*", action: "allow" },
			{ pattern: "third-party:*", action: "deny" },
		];

		it("should execute whitelisted builtin tool", async () => {
			const approval = createApprovalPipeline(store, rules);
			const executor = createToolExecutor({
				findTool: (name) => (name === "echo" ? echoTool : undefined),
				store,
				approval,
				getToolSource: () => "builtin",
			});

			const result = await executor.execute(
				makeCall("echo", { message: "hi" }),
				ctx,
			);
			expect(result.success).toBe(true);
			expect(result.parsedResult).toEqual({ echoed: "hi" });
		});

		it("should execute whitelisted local tool", async () => {
			const approval = createApprovalPipeline(store, rules);
			const executor = createToolExecutor({
				findTool: (name) => (name === "echo" ? echoTool : undefined),
				store,
				approval,
				getToolSource: () => "local",
			});

			const result = await executor.execute(
				makeCall("echo", { message: "hi" }),
				ctx,
			);
			expect(result.success).toBe(true);
		});

		it("should deny third-party tool", async () => {
			const approval = createApprovalPipeline(store, rules);
			const executor = createToolExecutor({
				findTool: (name) =>
					name === "dangerous-action" ? dangerousTool : undefined,
				store,
				approval,
				getToolSource: () => "third-party",
			});

			const result = await executor.execute(
				makeCall("dangerous-action", { target: "world" }),
				ctx,
			);
			expect(result.success).toBe(false);
			expect(result.result).toContain("denied");
		});

		it("should record correct approvalStatus in store", async () => {
			const approval = createApprovalPipeline(store, rules);
			const executor = createToolExecutor({
				findTool: (name) => (name === "echo" ? echoTool : undefined),
				store,
				approval,
				getToolSource: () => "builtin",
			});

			await executor.execute(makeCall("echo", { message: "test" }), ctx);
			const calls = await store.listToolCalls("sess-1");
			expect(calls).toHaveLength(1);
			expect(calls[0].approvalStatus).toBe("auto-allowed");
		});

		it("should record denied status in store", async () => {
			const approval = createApprovalPipeline(store, rules);
			const executor = createToolExecutor({
				findTool: (name) =>
					name === "dangerous-action" ? dangerousTool : undefined,
				store,
				approval,
				getToolSource: () => "third-party",
			});

			await executor.execute(
				makeCall("dangerous-action", { target: "x" }),
				ctx,
			);
			const calls = await store.listToolCalls("sess-1");
			expect(calls).toHaveLength(1);
			expect(calls[0].approvalStatus).toBe("user-denied");
		});
	});

	describe("backward compatibility: no approval pipeline", () => {
		it("should auto-allow all tools when no approval configured", async () => {
			const executor = createToolExecutor({
				findTool: (name) => (name === "echo" ? echoTool : undefined),
				store,
			});

			const result = await executor.execute(
				makeCall("echo", { message: "legacy" }),
				ctx,
			);
			expect(result.success).toBe(true);

			const calls = await store.listToolCalls("sess-1");
			expect(calls[0].approvalStatus).toBe("auto-allowed");
		});
	});

	describe("exact tool name whitelist", () => {
		const rules: readonly PermissionRule[] = [
			{ pattern: "echo", action: "allow" },
			{ pattern: "third-party:*", action: "deny" },
		];

		it("should allow explicitly whitelisted tool by name", async () => {
			const approval = createApprovalPipeline(store, rules);
			const executor = createToolExecutor({
				findTool: (name) => (name === "echo" ? echoTool : undefined),
				store,
				approval,
				getToolSource: () => "third-party",
			});

			const result = await executor.execute(
				makeCall("echo", { message: "ok" }),
				ctx,
			);
			expect(result.success).toBe(true);
		});
	});
});
