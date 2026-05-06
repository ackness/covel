/**
 * Tests for SSRF protection in provider URL validation.
 */
import { describe, it, expect } from "vitest";
import { validateBaseUrl, buildProviderUrl } from "../src/adapters/http.js";

describe("validateBaseUrl", () => {
	describe("allowed URLs", () => {
		it("allows known provider domains", () => {
			expect(validateBaseUrl("https://api.openai.com")).toBe(true);
			expect(validateBaseUrl("https://api.anthropic.com")).toBe(true);
			expect(validateBaseUrl("https://api.deepseek.com")).toBe(true);
			expect(validateBaseUrl("https://dashscope.aliyuncs.com")).toBe(true);
			expect(validateBaseUrl("https://openrouter.ai")).toBe(true);
		});

		it("allows localhost for development", () => {
			expect(validateBaseUrl("http://localhost:11434")).toBe(true);
			expect(validateBaseUrl("http://127.0.0.1:8080")).toBe(true);
			expect(validateBaseUrl("http://localhost:3000/v1")).toBe(true);
		});

		it("allows subdomains of known providers", () => {
			expect(validateBaseUrl("https://models.api.openai.com")).toBe(true);
			expect(validateBaseUrl("https://eu.api.anthropic.com")).toBe(true);
		});
	});

	describe("blocked URLs", () => {
		it("blocks cloud metadata endpoints", () => {
			expect(validateBaseUrl("http://169.254.169.254/latest/meta-data/")).toBe(
				false,
			);
			expect(validateBaseUrl("http://metadata.google.internal")).toBe(false);
		});

		it("blocks private network ranges (RFC1918)", () => {
			expect(validateBaseUrl("http://10.0.0.1:8080")).toBe(false);
			expect(validateBaseUrl("http://192.168.1.1")).toBe(false);
			expect(validateBaseUrl("http://172.16.0.1")).toBe(false);
		});

		it("blocks link-local addresses", () => {
			expect(validateBaseUrl("http://169.254.1.1")).toBe(false);
		});

		it("blocks non-https for non-localhost external domains", () => {
			// http (non-TLS) is only allowed for loopback; remote endpoints require https
			expect(validateBaseUrl("http://internal-db:5432")).toBe(false);
			expect(validateBaseUrl("http://api.openai.com")).toBe(false);
		});

		it("allows any public https domain (open provider policy)", () => {
			// Users can bring their own providers — no domain allowlist
			expect(validateBaseUrl("https://my-company-llm.internal.corp/v1")).toBe(
				true,
			);
			expect(validateBaseUrl("https://custom-ai.example.com")).toBe(true);
		});

		it("blocks empty or malformed URLs", () => {
			expect(validateBaseUrl("")).toBe(false);
			expect(validateBaseUrl("not-a-url")).toBe(false);
			expect(validateBaseUrl("ftp://files.example.com")).toBe(false);
		});
	});

	describe("open provider policy", () => {
		it("allows any public https domain without configuration", () => {
			// Open policy: no domain allowlist — users bring their own providers
			expect(validateBaseUrl("https://any-llm-provider.io/api")).toBe(true);
			expect(validateBaseUrl("https://company.internal.corp/v1")).toBe(true);
		});
	});
});

describe("buildProviderUrl", () => {
	it("builds URL from base and path", () => {
		expect(
			buildProviderUrl("https://api.openai.com", "/v1/chat/completions"),
		).toBe("https://api.openai.com/v1/chat/completions");
	});

	it("handles trailing slash in base", () => {
		expect(buildProviderUrl("https://api.openai.com/", "v1/chat")).toBe(
			"https://api.openai.com/v1/chat",
		);
	});

	// ── Tolerant /v1 handling ─────────────────────────────────────
	//
	// All four forms below must yield the same canonical URL. Before
	// this tolerance was added, omitting /v1 from baseUrl silently
	// produced broken URLs — users had to remember which env vars
	// required the suffix and which didn't.

	it("injects /v1 when baseUrl has no version and path has no version", () => {
		expect(
			buildProviderUrl("https://api.openai.com", "/chat/completions"),
		).toBe("https://api.openai.com/v1/chat/completions");
	});

	it("keeps baseUrl version when path also carries it", () => {
		expect(
			buildProviderUrl("https://api.openai.com/v1", "/v1/chat/completions"),
		).toBe("https://api.openai.com/v1/chat/completions");
	});

	it("keeps baseUrl version when path is relative", () => {
		expect(
			buildProviderUrl("https://api.openai.com/v1", "/chat/completions"),
		).toBe("https://api.openai.com/v1/chat/completions");
	});

	it("handles http://localhost with no version suffix", () => {
		expect(buildProviderUrl("http://127.0.0.1:4012", "/chat/completions")).toBe(
			"http://127.0.0.1:4012/v1/chat/completions",
		);
	});

	it("handles http://localhost with explicit /v1 suffix", () => {
		expect(
			buildProviderUrl("http://127.0.0.1:4012/v1", "/chat/completions"),
		).toBe("http://127.0.0.1:4012/v1/chat/completions");
	});

	it("respects non-v1 version segments (v2, v1beta)", () => {
		expect(
			buildProviderUrl("https://api.example.com/v2", "/chat/completions"),
		).toBe("https://api.example.com/v2/chat/completions");
		expect(
			buildProviderUrl("https://api.example.com/v1beta", "/messages"),
		).toBe("https://api.example.com/v1beta/messages");
	});

	it("dedupes when path and base share a non-v1 version", () => {
		expect(
			buildProviderUrl("https://api.example.com/v2", "/v2/chat/completions"),
		).toBe("https://api.example.com/v2/chat/completions");
	});

	it("strips multiple trailing slashes", () => {
		expect(
			buildProviderUrl("https://api.openai.com///", "/chat/completions"),
		).toBe("https://api.openai.com/v1/chat/completions");
	});
});
