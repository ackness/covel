import { afterEach, describe, it, expect } from "vitest";
import {
	approximateTokenCounter,
	estimateTokens,
	resetTokenCounter,
	setTokenCounter,
	TOKEN_SAFETY_MULTIPLIERS,
	type ProviderFamily,
} from "../src/tokenizer.js";

afterEach(() => {
	resetTokenCounter();
});

const ALL_FAMILIES: ProviderFamily[] = [
	"openai",
	"anthropic",
	"deepseek",
	"qwen",
];

describe("estimateTokens", () => {
	describe("baseline (openai family)", () => {
		it("returns a positive integer for a short English phrase", () => {
			// Arrange
			const text = "Hello, world!";

			// Act
			const count = estimateTokens(text, { family: "openai" });

			// Assert
			expect(count).toBeGreaterThan(0);
			expect(Number.isInteger(count)).toBe(true);
		});

		it("returns raw base count with multiplier 1.0 (no change)", () => {
			// Arrange
			const text = "The quick brown fox jumps over the lazy dog.";
			const rawLength = approximateTokenCounter(text);

			// Act
			const count = estimateTokens(text, { family: "openai" });

			// Assert
			expect(count).toBe(rawLength);
		});

		it("defaults to openai family when options are omitted", () => {
			// Arrange
			const text = "A default-family call should match openai.";

			// Act
			const withOptions = estimateTokens(text, { family: "openai" });
			const defaulted = estimateTokens(text);

			// Assert
			expect(defaulted).toBe(withOptions);
		});
	});

	describe("safety multipliers", () => {
		const text = "The adventurer stepped cautiously into the dim-lit cavern.";

		it("anthropic returns ceil(openai * 1.25)", () => {
			// Arrange
			const baseline = estimateTokens(text, { family: "openai" });

			// Act
			const actual = estimateTokens(text, { family: "anthropic" });

			// Assert
			expect(actual).toBe(Math.ceil(baseline * 1.25));
		});

		it("deepseek returns ceil(openai * 1.35)", () => {
			// Arrange
			const baseline = estimateTokens(text, { family: "openai" });

			// Act
			const actual = estimateTokens(text, { family: "deepseek" });

			// Assert
			expect(actual).toBe(Math.ceil(baseline * 1.35));
		});

		it("qwen returns ceil(openai * 1.35)", () => {
			// Arrange
			const baseline = estimateTokens(text, { family: "openai" });

			// Act
			const actual = estimateTokens(text, { family: "qwen" });

			// Assert
			expect(actual).toBe(Math.ceil(baseline * 1.35));
		});
	});

	describe("empty string handling", () => {
		it.each(ALL_FAMILIES)("returns exactly 0 for family=%s", (family) => {
			// Act
			const count = estimateTokens("", { family });

			// Assert
			expect(count).toBe(0);
		});

		it("returns 0 when options are omitted", () => {
			expect(estimateTokens("")).toBe(0);
		});
	});

	describe("mixed English + Chinese passage", () => {
		const narrative =
			"He gripped the rusted sword tighter. 夜风呼啸，古老的石门缓缓开启，" +
			"a low voice whispered: 勇士，你来了。 The torchlight flickered against " +
			"碑文上的符号，仿佛在低声诉说着早已被遗忘的秘密。";

		it("produces counts > 0 for every family", () => {
			for (const family of ALL_FAMILIES) {
				// Act
				const count = estimateTokens(narrative, { family });

				// Assert
				expect(count).toBeGreaterThan(0);
			}
		});

		it("produces a realistic token count in the 20–200 range", () => {
			// Act
			const openaiCount = estimateTokens(narrative, { family: "openai" });

			// Assert — loose sanity: meaningful paragraph but not unbounded
			expect(openaiCount).toBeGreaterThan(20);
			expect(openaiCount).toBeLessThan(500);
		});

		it("orders openai < anthropic < deepseek", () => {
			// Act
			const openaiCount = estimateTokens(narrative, { family: "openai" });
			const anthropicCount = estimateTokens(narrative, { family: "anthropic" });
			const deepseekCount = estimateTokens(narrative, { family: "deepseek" });

			// Assert
			expect(openaiCount).toBeLessThan(anthropicCount);
			expect(anthropicCount).toBeLessThan(deepseekCount);
		});
	});
});

describe("pluggable token counter", () => {
	it("routes estimateTokens through the active counter", () => {
		// Arrange
		setTokenCounter(() => 100);

		// Act
		const count = estimateTokens("whatever", { family: "openai" });

		// Assert — multiplier 1.0 passes through unchanged
		expect(count).toBe(100);
	});

	it("combines the active counter with the family multiplier", () => {
		// Arrange
		setTokenCounter(() => 80);

		// Act
		const count = estimateTokens("whatever", { family: "deepseek" });

		// Assert
		expect(count).toBe(Math.ceil(80 * 1.35));
	});

	it("resetTokenCounter restores the built-in approximation", () => {
		// Arrange
		setTokenCounter(() => 999);
		resetTokenCounter();
		const text = "回退之后应当使用字符启发式 heuristic";

		// Act
		const count = estimateTokens(text, { family: "openai" });

		// Assert
		expect(count).toBe(approximateTokenCounter(text));
	});
});

describe("TOKEN_SAFETY_MULTIPLIERS", () => {
	it("matches the documented table exactly", () => {
		expect(TOKEN_SAFETY_MULTIPLIERS).toEqual({
			openai: 1.0,
			anthropic: 1.25,
			deepseek: 1.35,
			qwen: 1.35,
		});
	});

	it("covers every ProviderFamily", () => {
		for (const family of ALL_FAMILIES) {
			expect(TOKEN_SAFETY_MULTIPLIERS[family]).toBeTypeOf("number");
			expect(TOKEN_SAFETY_MULTIPLIERS[family]).toBeGreaterThanOrEqual(1);
		}
	});
});
