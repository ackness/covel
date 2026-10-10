/**
 * Public context assembly tests for `kind: 'plugin-data'` inject resolution.
 *
 * The internal sync path is tested separately in `context-builder.test.ts`;
 * these cases assert that:
 *   - sync path ignores plugin-data injects but still returns valid output
 *   - async path resolves runtime injects the same way the sync path does
 *   - async path materialises plugin-data injects via `store.getPluginDataPromptWindow`
 *   - empty namespaces render as `<tag>(none)</tag>`
 *   - two-pass truncation is stable and deterministic (anchors + recent)
 *   - summary / full / ids-only formats each serialise as specified
 *   - store errors propagate out of `buildContext`
 *   - `needsAsyncBuild` correctly detects plugin-data declarations
 */
import { describe, it, expect } from "vitest";
import { buildContext, type ContextBuildParams } from "@covel/context";
import { buildContextSync, needsAsyncBuild } from "../src/context-builder.js";
import {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  type RuntimeManifest,
  type RuntimeResult,
  type TurnInput,
} from "@covel/shared";
import type { DataStore, PluginDataRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";

// ── Helpers ─────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "codex",
    pluginId: "codex",
    description: "test codex",
    stage: "post-turn",
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "探索",
    origin: "player",
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

/** Keep accidental full-namespace reads visible while using the real projection. */
function makeStoreStub(entries: PluginDataRecord[]): DataStore {
  const store = createMemoryStore();
  const seeded = store.setPluginDataBatch(entries);
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "getPluginDataPromptWindow")
        return async (
          ...args: Parameters<DataStore["getPluginDataPromptWindow"]>
        ) => {
          await seeded;
          return target.getPluginDataPromptWindow(...args);
        };
      return () => {
        throw new Error(`unexpected store call: ${String(prop)}`);
      };
    },
  });
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

// ── buildContext — runtime inject regression ─────────────────────

describe("buildContext — runtime inject regression", () => {
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
    };

    const sync = buildContextSync(params);
    const asyncResult = await buildContext(params);

    expect(asyncResult.systemPrompt).toBe(sync.systemPrompt);
    expect(asyncResult.messages).toEqual(sync.messages);
    expect(asyncResult.turnContext).toBe(
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
    };
    const result = buildContextSync(params);
    expect(result.systemPrompt).toBe(`body${PROMPT_CACHE_BREAKPOINT_MARKER}`);
    expect(result.turnContext).toBe("");
  });
});

// ── buildContext — plugin-data inject ────────────────────────────

describe("buildContext — plugin-data inject", () => {
  function makeParams(
    store: DataStore,
    extraInjects: NonNullable<
      NonNullable<RuntimeManifest["input"]>["inject"]
    > = [],
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
      store,
    };
  }

  it("refuses to inject hidden world data into a prompt", async () => {
    const store = makeStoreStub([]);
    const params = makeParams(store);
    const manifest = makeManifest({
      input: {
        inject: [
          {
            kind: "plugin-data",
            namespace: "_hidden.events",
            as: "<events>",
            format: "summary",
            maxEntries: 50,
          },
        ],
      },
    });
    await expect(buildContext({ ...params, manifest })).rejects.toThrow(
      /cannot inject hidden world data/,
    );
  });

  it("injects <existing-entries>(none)</existing-entries> when namespace is empty", async () => {
    const store = makeStoreStub([]);
    const result = await buildContext(makeParams(store));
    expect(result.turnContext).toContain(
      "<existing-entries>(none)</existing-entries>",
    );
  });

  it("renders summary format with key + truncated value, without the row's time", async () => {
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
    const result = await buildContext(makeParams(store));
    expect(result.turnContext).toContain('- codex-fire-mountain | {"title"');
    expect(result.turnContext).toContain('- codex-blue-river | {"title"');
    expect(result.turnContext).not.toContain("2025-01-0");
    // Long value should be truncated with `...`
    expect(result.turnContext).toMatch(/火山[^\n]*\.\.\./);
  });

  it("propagates bounded projection errors (no silent fallback)", async () => {
    const store = new Proxy({} as DataStore, {
      get(_t, prop) {
        if (prop === "getPluginDataPromptWindow") {
          return async () => {
            throw new Error("store offline");
          };
        }
        return () => undefined;
      },
    });
    await expect(buildContext(makeParams(store))).rejects.toThrow(
      "store offline",
    );
  });

  it("throws when store is missing but plugin-data inject present", async () => {
    const params = makeParams(makeStoreStub([]));
    const { store: _store, ...withoutStore } = params;
    void _store;
    await expect(
      buildContext(withoutStore as ContextBuildParams),
    ).rejects.toThrow(/store is required/i);
  });
});

// ── buildContext — truncation semantics ──────────────────────────

describe("buildContext — two-pass truncation", () => {
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
    const result = await buildContext({
      promptTemplate: "body",
      manifest,
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      store,
    });

    // Anchors = 2 oldest created = codex-00, codex-01
    // Recent = 2 newest updated (excluding anchors) = codex-09, codex-08
    expect(result.turnContext).toContain("- codex-00");
    expect(result.turnContext).toContain("- codex-01");
    expect(result.turnContext).toContain("- codex-09");
    expect(result.turnContext).toContain("- codex-08");
    // middle entries excluded
    expect(result.turnContext).not.toContain("- codex-05");
    // count note shows we truncated
    expect(result.turnContext).toContain("10 entries in total, 4 shown");
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
    const result = await buildContext({
      promptTemplate: "body",
      manifest,
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      store,
    });
    expect(result.turnContext).toContain("- codex-a");
    expect(result.turnContext).toContain("- codex-b");
    expect(result.turnContext).not.toContain("entries in total");
  });
});

// ── buildContext — format variants ───────────────────────────────

describe("buildContext — format variants", () => {
  const entry = makeEntry(
    "codex-test",
    { title: "测试", content: "short" },
    "2025-01-01T00:00:00.000Z",
    "2025-01-02T00:00:00.000Z",
  );

  async function buildWithFormat(
    format: "summary" | "full" | "ids-only",
    row: PluginDataRecord = entry,
  ) {
    const store = makeStoreStub([row]);
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
    return buildContext({
      promptTemplate: "body",
      manifest,
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      store,
    });
  }

  it("ids-only outputs just the key", async () => {
    const result = await buildWithFormat("ids-only");
    expect(result.turnContext).toContain("- codex-test");
    expect(result.turnContext).not.toContain("测试");
  });

  it("full outputs the complete JSON value", async () => {
    const result = await buildWithFormat("full");
    expect(result.turnContext).toContain(
      '- codex-test: {"title":"测试","content":"short"}',
    );
  });

  it("summary is the key and compact JSON", async () => {
    const result = await buildWithFormat("summary");
    expect(result.turnContext).toContain("- codex-test | {");
    expect(result.turnContext).toContain("测试");
  });

  it("leaves a value's bookkeeping out of the summary and the full format", async () => {
    const row = makeEntry(
      "edge-knows-about-1",
      {
        id: "edge-knows-about-1",
        fact: "认识守灯人",
        validAt: 2,
        evidenceTurnIds: ["a9a3b91b-04c1-4f6e-9a57-2f1d6c0b7e11"],
        lastTurnId: "0f1efa4d-b478-4a0c-8665-c040097771b4",
        sessionId: "lantern-barrow-replay",
        unlockedAt: "2026-10-06T08:51:22.123Z",
      },
      "2025-01-01T00:00:00.000Z",
      "2025-01-02T00:00:00.000Z",
    );
    // The row key is on the line, so the value does not repeat it as `id`.
    expect((await buildWithFormat("summary", row)).turnContext).toContain(
      '- edge-knows-about-1 | {"fact":"认识守灯人","validAt":2}',
    );
    expect((await buildWithFormat("full", row)).turnContext).toContain(
      '- edge-knows-about-1: {"fact":"认识守灯人","validAt":2}',
    );
  });

  it("keeps an id that is not the row key", async () => {
    const row = makeEntry(
      "turn-7",
      { id: "npc-lin-yao", note: "见过" },
      "2025-01-01T00:00:00.000Z",
      "2025-01-02T00:00:00.000Z",
    );
    expect((await buildWithFormat("summary", row)).turnContext).toContain(
      '- turn-7 | {"id":"npc-lin-yao","note":"见过"}',
    );
  });
});
