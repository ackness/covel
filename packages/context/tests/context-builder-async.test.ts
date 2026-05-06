/**
 * Async build path tests — covers `buildContextAsync`, `needsAsyncBuild`,
 * and the new `kind: 'plugin-data'` inject resolution.
 *
 * The sync `buildContext` path is tested separately in `context-builder.test.ts`;
 * these cases assert that:
 *   - sync path ignores plugin-data injects but still returns valid output
 *   - async path resolves runtime injects the same way the sync path does
 *   - async path materialises plugin-data injects via `store.listPluginData`
 *   - empty namespaces render as `<tag>暂无</tag>`
 *   - two-pass truncation is stable and deterministic (anchors + recent)
 *   - summary / full / ids-only formats each serialise as specified
 *   - store errors propagate out of `buildContextAsync`
 *   - `needsAsyncBuild` correctly detects plugin-data declarations
 */
import { describe, it, expect, vi } from "vitest";
import {
	buildContext,
	buildContextAsync,
	needsAsyncBuild,
	type ContextBuildParams,
} from "@covel/context";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { DataStore, PluginDataRecord } from "@covel/store";

// ── Helpers ─────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
	return {
		name: "codex",
		pluginId: "codex",
		description: "test codex",
		priority: 650,
		...overrides,
	};
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
	return {
		sessionId: "sess-1",
		turnId: "turn-1",
		playerMessage: "探索",
		...overrides,
	};
}

function makeRuntimeResult(output: Record<string, unknown>): RuntimeResult {
	return {
		pluginId: "narrator",
		runtimeId: "narrator",
		runId: "run-1",
		turnId: "turn-1",
		status: "success",
		output,
		toolCalls: [],
		durationMs: 100,
		timestamp: new Date().toISOString(),
	};
}

function makeEntry(
	key: string,
	value: unknown,
	createdAt: string,
	updatedAt: string,
): PluginDataRecord {
	return {
		id: `id-${key}`,
		sessionId: "sess-1",
		pluginId: "codex",
		namespace: "entries",
		key,
		value,
		createdAt,
		updatedAt,
	};
}

/**
 * Minimal DataStore stub — only implements `listPluginData`. Other methods
 * throw if touched, so tests fail loudly if the async build path accidentally
 * calls something besides `listPluginData`.
 */
function makeStoreStub(entries: PluginDataRecord[]): DataStore {
	const handler: ProxyHandler<DataStore> = {
		get(_target, prop) {
			if (prop === "listPluginData") {
				return vi.fn(async () => entries);
			}
			return () => {
				throw new Error(`unexpected store call: ${String(prop)}`);
			};
		},
	};
	return new Proxy({} as DataStore, handler);
}

// ── needsAsyncBuild ──────────────────────────────────────────────

describe("needsAsyncBuild", () => {
	it("returns false when manifest has no injects", () => {
		const manifest = makeManifest();
		expect(needsAsyncBuild({ manifest })).toBe(false);
	});

	it("returns false when all injects are runtime kind", () => {
		const manifest = makeManifest({
			input: {
				inject: [
					{
						kind: "runtime",
						from: "narrator",
						field: "narrativeOutput",
						as: "<narrator-output>",
					},
				],
			},
		});
		expect(needsAsyncBuild({ manifest })).toBe(false);
	});

	it("returns true when any inject is plugin-data kind", () => {
		const manifest = makeManifest({
			input: {
				inject: [
					{
						kind: "runtime",
						from: "narrator",
						field: "narrativeOutput",
						as: "<narrator-output>",
					},
					{
						kind: "plugin-data",
						namespace: "entries",
						as: "<existing-entries>",
						format: "summary",
						maxEntries: 50,
					},
				],
			},
		});
		expect(needsAsyncBuild({ manifest })).toBe(true);
	});
});

// ── buildContextAsync — runtime inject regression ────────────────

describe("buildContextAsync — runtime inject regression", () => {
	it("resolves runtime injects identically to the sync path", async () => {
		const manifest = makeManifest({
			input: {
				inject: [
					{
						kind: "runtime",
						from: "narrator",
						field: "narrativeOutput",
						as: "<narrator-output>",
					},
				],
			},
		});
		const results = new Map<string, RuntimeResult>([
			["narrator", makeRuntimeResult({ narrativeOutput: "你走到了山脚下。" })],
		]);

		const params: ContextBuildParams = {
			promptTemplate: "You are the codex keeper.",
			manifest,
			turnInput: makeTurnInput(),
			completedResults: results,
			config: {},
		};

		const sync = buildContext(params);
		const asyncResult = await buildContextAsync(params);

		expect(asyncResult.systemPrompt).toBe(sync.systemPrompt);
		expect(asyncResult.messages).toEqual(sync.messages);
		expect(asyncResult.systemPrompt).toContain(
			"<narrator-output>你走到了山脚下。</narrator-output>",
		);
	});

	it("sync path silently skips plugin-data injects (does not throw)", () => {
		const manifest = makeManifest({
			input: {
				inject: [
					{
						kind: "plugin-data",
						namespace: "entries",
						as: "<existing-entries>",
						format: "summary",
						maxEntries: 50,
					},
				],
			},
		});
		const params: ContextBuildParams = {
			promptTemplate: "body",
			manifest,
			turnInput: makeTurnInput(),
			completedResults: new Map(),
			config: {},
		};
		const result = buildContext(params);
		expect(result.systemPrompt).toBe("body");
		expect(result.systemPrompt).not.toContain("<existing-entries>");
	});
});

// ── buildContextAsync — plugin-data inject ───────────────────────

describe("buildContextAsync — plugin-data inject", () => {
	function makeParams(
		store: DataStore,
		extraInjects: RuntimeManifest["input"] extends { inject?: infer U }
			? U
			: never = [],
	): ContextBuildParams {
		const manifest = makeManifest({
			input: {
				inject: [
					{
						kind: "plugin-data",
						namespace: "entries",
						as: "<existing-entries>",
						format: "summary",
						maxEntries: 50,
					},
					...(extraInjects ?? []),
				],
			},
		});
		return {
			promptTemplate: "Existing codex follows.",
			manifest,
			turnInput: makeTurnInput(),
			completedResults: new Map(),
			config: {},
			store,
		};
	}

	it("injects <existing-entries>暂无</existing-entries> when namespace is empty", async () => {
		const store = makeStoreStub([]);
		const result = await buildContextAsync(makeParams(store));
		expect(result.systemPrompt).toContain(
			"<existing-entries>暂无</existing-entries>",
		);
	});

	it("renders summary format with key + updatedAt + truncated value", async () => {
		const entries = [
			makeEntry(
				"codex-fire-mountain",
				{ title: "火山", content: "long lore ".repeat(30), rarity: "rare" },
				"2025-01-01T00:00:00.000Z",
				"2025-01-02T00:00:00.000Z",
			),
			makeEntry(
				"codex-blue-river",
				{ title: "蓝河", content: "清澈的河水", rarity: "common" },
				"2025-01-03T00:00:00.000Z",
				"2025-01-04T00:00:00.000Z",
			),
		];
		const store = makeStoreStub(entries);
		const result = await buildContextAsync(makeParams(store));
		expect(result.systemPrompt).toContain(
			"- codex-fire-mountain | 2025-01-02T00:00:00.000Z",
		);
		expect(result.systemPrompt).toContain(
			"- codex-blue-river | 2025-01-04T00:00:00.000Z",
		);
		// Long value should be truncated with `...`
		expect(result.systemPrompt).toMatch(/火山[^\n]*\.\.\./);
	});

	it("propagates listPluginData errors (no silent fallback)", async () => {
		const store = new Proxy({} as DataStore, {
			get(_t, prop) {
				if (prop === "listPluginData") {
					return async () => {
						throw new Error("store offline");
					};
				}
				return () => undefined;
			},
		});
		await expect(buildContextAsync(makeParams(store))).rejects.toThrow(
			"store offline",
		);
	});

	it("throws when store is missing but plugin-data inject present", async () => {
		const params = makeParams(makeStoreStub([]));
		const { store: _store, ...withoutStore } = params;
		void _store;
		await expect(
			buildContextAsync(withoutStore as ContextBuildParams),
		).rejects.toThrow(/store is required/i);
	});
});

// ── buildContextAsync — truncation semantics ─────────────────────

describe("buildContextAsync — two-pass truncation", () => {
	it("picks oldest anchors + most-recently-updated when capped", async () => {
		// 10 entries, maxEntries=4 → anchorQuota=2 (oldest by createdAt),
		// recentQuota=2 (newest by updatedAt, excluding anchors).
		const entries: PluginDataRecord[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(
				makeEntry(
					`codex-${String(i).padStart(2, "0")}`,
					{ n: i },
					`2025-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, // createdAt asc with i
					`2025-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, // updatedAt asc with i
				),
			);
		}
		const store = makeStoreStub(entries);
		const manifest = makeManifest({
			input: {
				inject: [
					{
						kind: "plugin-data",
						namespace: "entries",
						as: "<existing-entries>",
						format: "ids-only",
						maxEntries: 4,
					},
				],
			},
		});
		const result = await buildContextAsync({
			promptTemplate: "body",
			manifest,
			turnInput: makeTurnInput(),
			completedResults: new Map(),
			config: {},
			store,
		});

		// Anchors = 2 oldest created = codex-00, codex-01
		// Recent = 2 newest updated (excluding anchors) = codex-09, codex-08
		expect(result.systemPrompt).toContain("- codex-00");
		expect(result.systemPrompt).toContain("- codex-01");
		expect(result.systemPrompt).toContain("- codex-09");
		expect(result.systemPrompt).toContain("- codex-08");
		// middle entries excluded
		expect(result.systemPrompt).not.toContain("- codex-05");
		// count note shows we truncated
		expect(result.systemPrompt).toContain("总计 10 条，展示 4 条");
	});

	it("returns all entries when count <= maxEntries (no truncation)", async () => {
		const entries = [
			makeEntry(
				"codex-a",
				{ n: 1 },
				"2025-01-01T00:00:00.000Z",
				"2025-01-01T00:00:00.000Z",
			),
			makeEntry(
				"codex-b",
				{ n: 2 },
				"2025-01-02T00:00:00.000Z",
				"2025-01-02T00:00:00.000Z",
			),
		];
		const store = makeStoreStub(entries);
		const manifest = makeManifest({
			input: {
				inject: [
					{
						kind: "plugin-data",
						namespace: "entries",
						as: "<existing-entries>",
						format: "ids-only",
						maxEntries: 50,
					},
				],
			},
		});
		const result = await buildContextAsync({
			promptTemplate: "body",
			manifest,
			turnInput: makeTurnInput(),
			completedResults: new Map(),
			config: {},
			store,
		});
		expect(result.systemPrompt).toContain("- codex-a");
		expect(result.systemPrompt).toContain("- codex-b");
		expect(result.systemPrompt).not.toContain("总计");
	});
});

// ── buildContextAsync — format variants ──────────────────────────

describe("buildContextAsync — format variants", () => {
	const entry = makeEntry(
		"codex-test",
		{ title: "测试", content: "short" },
		"2025-01-01T00:00:00.000Z",
		"2025-01-02T00:00:00.000Z",
	);

	async function buildWithFormat(format: "summary" | "full" | "ids-only") {
		const store = makeStoreStub([entry]);
		const manifest = makeManifest({
			input: {
				inject: [
					{
						kind: "plugin-data",
						namespace: "entries",
						as: "<existing-entries>",
						format,
						maxEntries: 50,
					},
				],
			},
		});
		return buildContextAsync({
			promptTemplate: "body",
			manifest,
			turnInput: makeTurnInput(),
			completedResults: new Map(),
			config: {},
			store,
		});
	}

	it("ids-only outputs just the key", async () => {
		const result = await buildWithFormat("ids-only");
		expect(result.systemPrompt).toContain("- codex-test");
		expect(result.systemPrompt).not.toContain("测试");
	});

	it("full outputs the complete JSON value", async () => {
		const result = await buildWithFormat("full");
		expect(result.systemPrompt).toContain(
			'- codex-test: {"title":"测试","content":"short"}',
		);
	});

	it("summary includes updatedAt and compact JSON", async () => {
		const result = await buildWithFormat("summary");
		expect(result.systemPrompt).toContain(
			"- codex-test | 2025-01-02T00:00:00.000Z |",
		);
		expect(result.systemPrompt).toContain("测试");
	});
});
