import { describe, it, expect } from "vitest";
import { applyBudget } from "@covel/context";
import type { TokenEstimator } from "@covel/context";

// Deterministic mock estimator: 1 token per 4 characters (rounded up).
const mockEstimator: TokenEstimator = (text) => Math.ceil(text.length / 4);

interface TestMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

function msg(role: TestMessage["role"], content: string): TestMessage {
	return { role, content };
}

// Build content of exactly `chars` characters (single 'a' repeated).
function contentOfChars(chars: number): string {
	return "a".repeat(chars);
}

describe("applyBudget", () => {
	it("returns unchanged when total is under budget", () => {
		const systemPrompt = contentOfChars(40); // 10 tokens
		const messages: TestMessage[] = [
			msg("user", contentOfChars(40)), // 10
			msg("assistant", contentOfChars(40)), // 10
			msg("user", contentOfChars(40)), // 10
		];

		const result = applyBudget(systemPrompt, messages, {
			maxInputTokens: 10_000,
			reservedForResponse: 4_000,
			estimator: mockEstimator,
		});

		expect(result.messages).toEqual(messages);
		expect(result.prunedMessageCount).toBe(0);
		expect(result.budgetExceeded).toBe(false);
		expect(result.totalTokens).toBe(10 + 10 + 10 + 10);
	});

	it("handles empty message list", () => {
		const systemPrompt = contentOfChars(40); // 10 tokens
		const result = applyBudget<TestMessage>(systemPrompt, [], {
			maxInputTokens: 1_000,
			reservedForResponse: 100,
			estimator: mockEstimator,
		});

		expect(result.messages).toEqual([]);
		expect(result.prunedMessageCount).toBe(0);
		expect(result.budgetExceeded).toBe(false);
		expect(result.totalTokens).toBe(10);
	});

	it("prunes oldest messages and inserts placeholder", () => {
		// 10 messages × 40 chars each = 10 × 10 tokens = 100 tokens of messages.
		// systemPrompt: 40 chars = 10 tokens. Total = 110 tokens.
		// effective cap = maxInputTokens - reservedForResponse.
		// With maxInputTokens=100, reservedForResponse=30 → cap=70.
		// Need to drop at least enough so kept <= 70.
		// kept_messages_tokens + 10 system <= 70 → kept messages <= 60 tokens = 6 messages.
		// So must drop 4 oldest (but protect window of last 2 user turns applies).
		//
		// Sequence: u, a, u, a, u, a, u, a, u, a (alternating, 5 user turns).
		// Protect window: last 2 user messages (at indices 6 and 8) plus everything after.
		// protectStartIndex should be 6 (the 4th-from-last message, which is u at index 6).
		// Pruneable range = indices 0..5 (6 messages).
		const systemPrompt = contentOfChars(40); // 10 tokens
		const messages: TestMessage[] = [
			msg("user", contentOfChars(40)), // 0
			msg("assistant", contentOfChars(40)), // 1
			msg("user", contentOfChars(40)), // 2
			msg("assistant", contentOfChars(40)), // 3
			msg("user", contentOfChars(40)), // 4
			msg("assistant", contentOfChars(40)), // 5
			msg("user", contentOfChars(40)), // 6  ← protect start (3rd-from-last user)
			msg("assistant", contentOfChars(40)), // 7
			msg("user", contentOfChars(40)), // 8  ← 2nd-from-last user
			msg("assistant", contentOfChars(40)), // 9
		];

		const result = applyBudget(systemPrompt, messages, {
			maxInputTokens: 100,
			reservedForResponse: 30,
			estimator: mockEstimator,
		});

		// After pruning we must be <= 70 total tokens.
		// Drop 4 oldest (40 tokens): total = 110 - 40 = 70. Placeholder adds ~18 tokens.
		expect(result.budgetExceeded).toBe(true);
		expect(result.prunedMessageCount).toBe(4);
		expect(result.messages[0]!.role).toBe("system");
		expect(result.messages[0]!.content).toMatch(
			/\[\.\.\. 4 older messages pruned/,
		);
		// Original messages at indices 4..9 survive (6 messages) + 1 placeholder = 7.
		expect(result.messages.length).toBe(7);
		// Last original user message (index 8, then index 9 assistant) must be intact.
		expect(result.messages[result.messages.length - 1]).toEqual(messages[9]);
		expect(result.messages[result.messages.length - 2]).toEqual(messages[8]);
	});

	it("protects last 2 user turns by default", () => {
		// [u1, a1, u2, a2, u3, a3, u4, a4] — 4 user turns.
		// Protect window = u3 onwards (indices 4..7).
		// With an aggressive budget, verify u3, a3, u4, a4 are all kept.
		const systemPrompt = "";
		const messages: TestMessage[] = [
			msg("user", contentOfChars(400)), // u1 100 tokens
			msg("assistant", contentOfChars(400)), // a1 100
			msg("user", contentOfChars(400)), // u2 100
			msg("assistant", contentOfChars(400)), // a2 100
			msg("user", contentOfChars(400)), // u3 100  ← protect start
			msg("assistant", contentOfChars(400)), // a3 100
			msg("user", contentOfChars(400)), // u4 100
			msg("assistant", contentOfChars(400)), // a4 100
		];

		const result = applyBudget(systemPrompt, messages, {
			maxInputTokens: 500,
			reservedForResponse: 0, // effective cap 500
			estimator: mockEstimator,
		});

		// u3, a3, u4, a4 must all be present in order.
		const protectedTail = result.messages.slice(-4);
		expect(protectedTail).toEqual(messages.slice(4, 8));
		expect(result.budgetExceeded).toBe(true);
		// Pruned count > 0 since budget forces dropping u1/a1/u2/a2.
		expect(result.prunedMessageCount).toBeGreaterThan(0);
	});

	it("returns budgetExceeded when protected tail alone exceeds budget", () => {
		const systemPrompt = "";
		// Single huge user message, way over budget.
		const messages: TestMessage[] = [
			msg("user", contentOfChars(10_000)), // 2500 tokens
		];

		const result = applyBudget(systemPrompt, messages, {
			maxInputTokens: 500,
			reservedForResponse: 0,
			estimator: mockEstimator,
		});

		// Protected (only user msg is in protect window).
		expect(result.messages).toEqual(messages);
		expect(result.prunedMessageCount).toBe(0);
		expect(result.budgetExceeded).toBe(true);
	});

	it("does nothing when fewer user messages than protectLastUserTurns", () => {
		const systemPrompt = "";
		const messages: TestMessage[] = [
			msg("user", contentOfChars(4_000)), // 1000 tokens
			msg("assistant", contentOfChars(4_000)), // 1000 tokens
		];

		const result = applyBudget(systemPrompt, messages, {
			maxInputTokens: 500,
			reservedForResponse: 0,
			protectLastUserTurns: 2,
			estimator: mockEstimator,
		});

		// Only 1 user message exists but we want 2 protected → entire list protected.
		expect(result.messages).toEqual(messages);
		expect(result.prunedMessageCount).toBe(0);
		expect(result.budgetExceeded).toBe(true);
	});

	it("honors reservedForResponse in effective cap", () => {
		// maxInputTokens=10_000, reservedForResponse=6_000 → cap=4_000.
		// systemPrompt: 0 tokens. 10 messages × 4000 chars = 10 × 1000 = 10_000 tokens.
		// Must prune until <= 4000. But protect window saves last 2 user turns.
		const systemPrompt = "";
		const messages: TestMessage[] = [];
		for (let i = 0; i < 5; i++) {
			messages.push(msg("user", contentOfChars(4_000))); // 1000 tokens each
			messages.push(msg("assistant", contentOfChars(4_000))); // 1000 tokens each
		}
		// 10 messages, 5 user turns, 10_000 total tokens.
		// Protect window: last 2 user messages + everything after.
		// user turns at indices 0, 2, 4, 6, 8. 2nd-from-last user = index 6. Protect indices 6..9.
		// Protected tail = 4 messages × 1000 = 4000 tokens — already equals cap.
		//
		// Pruneable = indices 0..5 (6 messages × 1000 = 6000 tokens).
		// Must drop enough so total <= 4000. We have 10_000 total.
		// Drop 6 messages (6000 tokens) → 4000 left. Placeholder adds ~18 tokens.

		const result = applyBudget(systemPrompt, messages, {
			maxInputTokens: 10_000,
			reservedForResponse: 6_000,
			estimator: mockEstimator,
		});

		expect(result.budgetExceeded).toBe(true);
		expect(result.prunedMessageCount).toBe(6);
		// 4 survivors + 1 placeholder = 5.
		expect(result.messages.length).toBe(5);
	});

	it("returns budgetExceeded when maxInputTokens <= reservedForResponse", () => {
		const systemPrompt = contentOfChars(40); // 10 tokens
		const messages: TestMessage[] = [msg("user", contentOfChars(40))];

		const result = applyBudget(systemPrompt, messages, {
			maxInputTokens: 1_000,
			reservedForResponse: 2_000, // cap = -1_000
			estimator: mockEstimator,
		});

		expect(result.messages).toEqual(messages);
		expect(result.prunedMessageCount).toBe(0);
		expect(result.budgetExceeded).toBe(true);
		expect(result.totalTokens).toBe(10); // only systemTokens
	});

	it("does not prune when total exactly equals budget cap", () => {
		const systemPrompt = contentOfChars(40); // 10 tokens
		// Messages totaling 40 tokens → total 50, cap 50.
		const messages: TestMessage[] = [
			msg("user", contentOfChars(40)), // 10
			msg("assistant", contentOfChars(40)), // 10
			msg("user", contentOfChars(40)), // 10
			msg("assistant", contentOfChars(40)), // 10
		];

		const result = applyBudget(systemPrompt, messages, {
			maxInputTokens: 100,
			reservedForResponse: 50, // cap=50
			estimator: mockEstimator,
		});

		expect(result.messages).toEqual(messages);
		expect(result.prunedMessageCount).toBe(0);
		expect(result.budgetExceeded).toBe(false);
		expect(result.totalTokens).toBe(50);
	});

	it("counts placeholder tokens in totalTokens", () => {
		const systemPrompt = contentOfChars(40); // 10 tokens
		const messages: TestMessage[] = [
			msg("user", contentOfChars(40)), // 10
			msg("assistant", contentOfChars(40)), // 10
			msg("user", contentOfChars(40)), // 10
			msg("assistant", contentOfChars(40)), // 10
			msg("user", contentOfChars(40)), // 10
			msg("assistant", contentOfChars(40)), // 10
		];
		// Total = 10 + 60 = 70. Cap = 20 → must prune.
		// Protect window covers last 2 user messages (indices 2, 4) so start = 2.
		// Pruneable = indices 0..1 (2 messages, 20 tokens).
		// After draining both: total = 70 - 20 = 50. Still > 20 (cap). No more to prune.
		// prunedMessageCount = 2.
		// Placeholder content = '[... 2 older messages pruned to stay within token budget ...]'
		//   length = 57 chars → ceil(57/4) = 15 tokens.
		// Expected totalTokens = 50 + 15 = 65.
		const result = applyBudget(systemPrompt, messages, {
			maxInputTokens: 100,
			reservedForResponse: 80, // cap=20
			estimator: mockEstimator,
		});

		expect(result.prunedMessageCount).toBe(2);
		expect(result.budgetExceeded).toBe(true);
		const placeholderTokens = mockEstimator(result.messages[0]!.content);
		expect(result.totalTokens).toBe(50 + placeholderTokens);
	});
});
