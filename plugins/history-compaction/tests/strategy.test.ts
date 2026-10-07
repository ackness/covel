/**
 * Unit tests for the Compactor.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";
import {
  maybeCompact as applyCompaction,
  createPromptLoader,
  type CompactorDeps as BudgetDeps,
  type CompactorOptions,
} from "@covel/context";
import {
  compactHistory,
  type CompactionPolicyOptions,
  type CompactorLLMAdapter,
} from "../server/strategy.js";
interface CompactorDeps extends Omit<BudgetDeps, "compact"> {
  fastSlotLlm: CompactorLLMAdapter;
}
const minimalHistories = new WeakMap<object, Map<string, TurnMessageRecord>>();
const defaultPromptsRoot = new URL("../prompts", import.meta.url).pathname;
let loadPrompt = createPromptLoader(defaultPromptsRoot);
async function maybeCompact(
  sessionId: string,
  system: string,
  messages: readonly TurnMessageRecord[],
  deps: CompactorDeps,
  opts?: CompactorOptions & CompactionPolicyOptions,
) {
  const minimalHistory = minimalHistories.get(deps.store);
  if (minimalHistory)
    for (const message of messages) {
      if (!minimalHistory.has(message.id))
        minimalHistory.set(message.id, message);
    }
  return applyCompaction(
    sessionId,
    system,
    messages,
    {
      ...deps,
      compact: (input) => compactHistory(input, { ...deps, loadPrompt }, opts),
    },
    opts,
  );
}
import { createMemoryStore } from "@covel/store/memory";
import type {
  DataStore,
  StoreTransaction,
  TurnMessageRecord,
  SessionSummaryRecord,
} from "@covel/store";

// ── Helpers ─────────────────────────────────────────────────────

function makeTurnMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  overrides?: Partial<TurnMessageRecord>,
): TurnMessageRecord {
  return {
    id,
    sessionId: "sess-1",
    turnId: "turn-1",
    sourceType: role === "user" ? "player" : "runtime",
    role,
    content,
    order: 500,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSimpleHistory(size = 10): TurnMessageRecord[] {
  const msgs: TurnMessageRecord[] = [];
  for (let i = 0; i < size; i++) {
    msgs.push(
      makeTurnMessage(
        `msg-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        `message content ${i} `.repeat(50), // ~600 chars each
        { createdAt: new Date(i).toISOString() },
      ),
    );
  }
  return msgs;
}

function makeMinimalStore(): DataStore {
  const summaries: SessionSummaryRecord[] = [];
  const messages = new Map<string, TurnMessageRecord>();

  const store = {
    listUncompactedTurnMessages: async (_sessionId: string, limit?: number) =>
      [...messages.values()]
        .filter((message) => message.compactedAtTurnId == null)
        .slice(0, limit),
    saveSessionSummary: vi.fn(async (s: SessionSummaryRecord) => {
      summaries.push(s);
    }),
    listSessionSummaries: vi.fn(async () => [...summaries]),
    deleteSessionSummaries: vi.fn(
      async (_sessionId: string, ids?: readonly string[]) => {
        for (let index = summaries.length - 1; index >= 0; index--) {
          if (!ids || ids.includes(summaries[index]!.id))
            summaries.splice(index, 1);
        }
      },
    ),
    tagTurnMessagesCompacted: vi.fn(
      async (
        _sessionId: string,
        messageIds: readonly string[],
        summaryId: string,
      ) => {
        for (const msgId of messageIds) {
          const msg = messages.get(msgId);
          if (msg) {
            messages.set(msgId, { ...msg, compactedAtTurnId: summaryId });
          }
        }
      },
    ),
    retagCompactedTurnMessages: vi.fn(
      async (
        _sessionId: string,
        summaryId: string,
        sourceIds?: readonly string[],
      ) => {
        for (const [id, message] of messages) {
          if (
            message.compactedAtTurnId != null &&
            (!sourceIds || sourceIds.includes(message.compactedAtTurnId))
          ) {
            messages.set(id, { ...message, compactedAtTurnId: summaryId });
          }
        }
      },
    ),
    addTraceEvent: vi.fn(async () => {}),
    withTransaction: async <T>(
      fn: (tx: StoreTransaction) => Promise<T>,
    ): Promise<T> => fn(store as unknown as StoreTransaction),
  } as unknown as DataStore;
  minimalHistories.set(store, messages);
  return store;
}

function makeEstimator(): (text: string) => number {
  return (text: string) => Math.ceil(text.length / 4);
}

function makeFastLlm(
  response = "Compact summary content.",
): CompactorLLMAdapter {
  return {
    complete: vi.fn(async () => ({ content: response })),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("maybeCompact", () => {
  let store: DataStore;
  let fastSlotLlm: CompactorLLMAdapter;
  let estimator: (text: string) => number;

  beforeEach(() => {
    store = makeMinimalStore();
    fastSlotLlm = makeFastLlm();
    estimator = makeEstimator();
  });

  describe("under threshold — no compaction", () => {
    it("returns { compacted: false } when token count is below threshold", async () => {
      const messages = [
        makeTurnMessage("m1", "user", "Hi"),
        makeTurnMessage("m2", "assistant", "Hello"),
      ];
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 100_000, // very large
      };

      const result = await maybeCompact(
        "sess-1",
        "system prompt",
        messages,
        deps,
      );

      expect(result.compacted).toBe(false);
      expect(fastSlotLlm.complete).not.toHaveBeenCalled();
    });
  });

  describe("over threshold — compaction triggered", () => {
    it("calls fast LLM and saves summary when over threshold", async () => {
      const messages = makeSimpleHistory(20); // ~20 * 600 * 0.25 = 3000 tokens
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000, // tiny window → threshold = 600 tokens
      };

      const result = await maybeCompact("sess-1", "", messages, deps, {
        threshold: 0.6,
        protectLastNUserTurns: 2,
        protectLastNMessages: 5,
      });

      expect(result.compacted).toBe(true);
      expect(result.summaryId).toBeDefined();
      expect(fastSlotLlm.complete).toHaveBeenCalledOnce();
      expect(store.saveSessionSummary).toHaveBeenCalledOnce();
      expect(store.tagTurnMessagesCompacted).toHaveBeenCalledOnce();
    });

    it("files the context.compacted trace under the turn traceId when provided (L-8)", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      const result = await maybeCompact("sess-1", "", messages, deps, {
        threshold: 0.6,
        traceId: "turn-trace-123",
      });

      expect(result.compacted).toBe(true);
      const traceCall = vi
        .mocked(store.addTraceEvent)
        .mock.calls.find(([e]) => e.type === "context.compacted");
      expect(traceCall?.[0].traceId).toBe("turn-trace-123");
    });

    it("skips compaction when the fast LLM returns empty/whitespace content", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm: makeFastLlm("   "), // whitespace-only response
        contextWindow: 1_000,
      };

      const result = await maybeCompact("sess-1", "", messages, deps, {
        threshold: 0.6,
        protectLastNUserTurns: 2,
        protectLastNMessages: 5,
      });

      // An empty summary must NOT be persisted or tag the source messages
      // compacted — that would permanently drop real history.
      expect(result.compacted).toBe(false);
      expect(deps.fastSlotLlm.complete).toHaveBeenCalledOnce();
      expect(store.saveSessionSummary).not.toHaveBeenCalled();
      expect(store.tagTurnMessagesCompacted).not.toHaveBeenCalled();
    });

    it("stores the summary with correct sessionId and focusSections", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact(
        "sess-focus",
        "",
        messages.map((m) => ({ ...m, sessionId: "sess-focus" })),
        deps,
        {
          focusSections: ["narrative", "character-state"],
        },
      );

      const saved = (store.saveSessionSummary as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SessionSummaryRecord;
      expect(saved.sessionId).toBe("sess-focus");
      expect(saved.focusSections).toEqual(["narrative", "character-state"]);
      expect(saved.content).toBe("Compact summary content.");
    });
  });

  describe("protection rules", () => {
    it("does not compact when protect window covers all messages", async () => {
      const messages = makeSimpleHistory(4); // only 4 messages
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 100,
      };

      // Protect last 5 messages overall — but there are only 4 → all protected
      const result = await maybeCompact("sess-1", "", messages, deps, {
        protectLastNMessages: 5,
        protectLastNUserTurns: 0,
      });

      expect(result.compacted).toBe(false);
    });

    it("uses only the absolute tail when user-turn protection is disabled", async () => {
      const messages = makeSimpleHistory(6);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 100,
        inputWindow: 10_000,
      };

      await maybeCompact("sess-1", "", messages, deps, {
        protectLastNMessages: 1,
        protectLastNUserTurns: 0,
      });

      const taggedIds = vi.mocked(store.tagTurnMessagesCompacted).mock
        .calls[0]?.[1];
      expect(taggedIds).toEqual(
        messages.slice(0, -1).map((message) => message.id),
      );
    });

    it("protects at least the specified number of user turns", async () => {
      // Build a history with 6 user messages
      const messages: TurnMessageRecord[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push(
          makeTurnMessage(
            `m${i}`,
            i % 2 === 0 ? "user" : "assistant",
            `content ${i} `.repeat(80),
          ),
        );
      }
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 500,
      };

      await maybeCompact("sess-1", "", messages, deps, {
        protectLastNUserTurns: 2,
        protectLastNMessages: 1,
      });

      // The tagged messages should NOT include any of the last 2 user messages
      const taggedIds = (
        store.tagTurnMessagesCompacted as ReturnType<typeof vi.fn>
      ).mock.calls[0][1] as string[];

      // Count user messages in tagged set
      const taggedSet = new Set(taggedIds);
      const lastTwoUserTurns = messages
        .filter((m) => m.role === "user")
        .slice(-2);
      for (const msg of lastTwoUserTurns) {
        expect(taggedSet.has(msg.id)).toBe(false);
      }
    });
  });

  describe("multi-round compaction", () => {
    const opts = {
      threshold: 0.6,
      protectLastNUserTurns: 2,
      protectLastNMessages: 5,
    };

    function applyTags(
      messages: readonly TurnMessageRecord[],
      taggedIds: readonly string[],
      summaryId: string,
    ): TurnMessageRecord[] {
      const tagged = new Set(taggedIds);
      return messages.map((m) =>
        tagged.has(m.id) ? { ...m, compactedAtTurnId: summaryId } : m,
      );
    }

    function taggedIdsOfCall(call: number): string[] {
      return (store.tagTurnMessagesCompacted as ReturnType<typeof vi.fn>).mock
        .calls[call]![1] as string[];
    }

    function growHistory(from: number, to: number): TurnMessageRecord[] {
      const msgs: TurnMessageRecord[] = [];
      for (let i = from; i < to; i++) {
        msgs.push(
          makeTurnMessage(
            `msg-${i}`,
            i % 2 === 0 ? "user" : "assistant",
            `message content ${i} `.repeat(50),
          ),
        );
      }
      return msgs;
    }

    it("compacts a 2nd and 3rd round as the history keeps growing", async () => {
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
        inputWindow: 10_000,
      };

      // Round 1
      let messages = growHistory(0, 20);
      const r1 = await maybeCompact("sess-1", "", messages, deps, opts);
      expect(r1.compacted).toBe(true);
      const round1Ids = taggedIdsOfCall(0);
      messages = applyTags(messages, round1Ids, r1.summaryId!);

      // Round 2 — history grows past the threshold again
      messages = [...messages, ...growHistory(20, 40)];
      const r2 = await maybeCompact("sess-1", "", messages, deps, opts);
      expect(r2.compacted).toBe(true);
      expect(r2.summaryId).not.toBe(r1.summaryId);
      const round2Ids = taggedIdsOfCall(1);
      expect(round2Ids.length).toBeGreaterThan(0);
      // Only the fresh region is compacted — round-1 messages stay tagged
      // with their original summary.
      expect(round2Ids.some((id) => round1Ids.includes(id))).toBe(false);
      // The window starts right after the round-1 boundary.
      const firstFresh = messages.find((m) => m.compactedAtTurnId == null);
      expect(round2Ids[0]).toBe(firstFresh!.id);
      messages = applyTags(messages, round2Ids, r2.summaryId!);

      // Round 3
      messages = [...messages, ...growHistory(40, 60)];
      const r3 = await maybeCompact("sess-1", "", messages, deps, opts);
      expect(r3.compacted).toBe(true);
      const round3Ids = taggedIdsOfCall(2);
      expect(
        round3Ids.some(
          (id) => round1Ids.includes(id) || round2Ids.includes(id),
        ),
      ).toBe(false);
      expect(fastSlotLlm.complete).toHaveBeenCalledTimes(3);
      expect(await store.listSessionSummaries("sess-1")).toHaveLength(3);
      expect(store.deleteSessionSummaries).not.toHaveBeenCalled();
      expect(store.retagCompactedTurnMessages).not.toHaveBeenCalled();
      const laterPrompts = vi.mocked(fastSlotLlm.complete).mock.calls.slice(1);
      for (const [request] of laterPrompts) {
        expect(request.messages[0]!.content).not.toContain(
          "Compact summary content.",
        );
      }
    });

    it("bounds a persisted segment even when the provider overshoots", async () => {
      const oversized = "长期摘要内容".repeat(2_000);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm: makeFastLlm(oversized),
        contextWindow: 1_000,
      };

      const result = await maybeCompact(
        "sess-1",
        "",
        growHistory(0, 20),
        deps,
        opts,
      );

      expect(result.compacted).toBe(true);
      const summaries = await store.listSessionSummaries("sess-1");
      expect(summaries).toHaveLength(1);
      expect(estimator(summaries[0]!.content)).toBeLessThanOrEqual(128);
      expect(summaries[0]!.content).toContain("摘要已按上下文预算截断");
    });

    it("does not re-compact when all eligible messages are already summarized", async () => {
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
        inputWindow: 10_000,
      };

      let messages = growHistory(0, 20);
      const r1 = await maybeCompact("sess-1", "", messages, deps, opts);
      expect(r1.compacted).toBe(true);
      messages = applyTags(messages, taggedIdsOfCall(0), r1.summaryId!);

      const r2 = await maybeCompact("sess-1", "", messages, deps, opts);
      expect(r2.compacted).toBe(false);
      expect(fastSlotLlm.complete).toHaveBeenCalledTimes(1);
    });
  });

  describe("token estimate (effective prompt view)", () => {
    it("excludes already-compacted raw content from the estimate", async () => {
      // Huge tagged prefix + tiny fresh tail: the effective prompt view is
      // small, so compaction must not trigger even though the raw sum is huge.
      const tagged = makeSimpleHistory(20).map((m) => ({
        ...m,
        compactedAtTurnId: "sum-old",
      }));
      const fresh = [
        makeTurnMessage("f1", "user", "hi"),
        makeTurnMessage("f2", "assistant", "hello"),
        makeTurnMessage("f3", "user", "ok"),
        makeTurnMessage("f4", "assistant", "sure"),
      ];
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      const result = await maybeCompact(
        "sess-1",
        "",
        [...tagged, ...fresh],
        deps,
        // Protection leaves a non-empty compactable window (only the last
        // message is protected) so this pins the ESTIMATE gate, not the
        // window-emptiness gate.
        { threshold: 0.6, protectLastNUserTurns: 0, protectLastNMessages: 1 },
      );

      expect(result.compacted).toBe(false);
      expect(fastSlotLlm.complete).not.toHaveBeenCalled();
    });

    it("counts referenced summary content toward the estimate", async () => {
      // Fresh region alone is under the threshold; a big persisted summary
      // (substituted into the prompt view) pushes it over.
      const summaryId = "sum-big";
      const tagged = makeSimpleHistory(4).map((m, i) => ({
        ...m,
        id: `tag-${i}`,
        compactedAtTurnId: summaryId,
      }));
      const fresh: TurnMessageRecord[] = [];
      for (let i = 0; i < 10; i++) {
        fresh.push(
          makeTurnMessage(
            `fresh-${i}`,
            i % 2 === 0 ? "user" : "assistant",
            `fresh content ${i} `.repeat(7), // ~120 chars → ~30 tokens each
          ),
        );
      }
      const messages = [...tagged, ...fresh];
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000, // threshold = 600 tokens
      };
      const opts = {
        threshold: 0.6,
        protectLastNUserTurns: 2,
        protectLastNMessages: 5,
      };

      // Without the summary record: fresh tail ≈ 300 tokens → under threshold.
      const before = await maybeCompact("sess-1", "", messages, deps, opts);
      expect(before.compacted).toBe(false);

      // With a 3000-char (~750-token) summary: over threshold → compacts the
      // fresh region only.
      await store.saveSessionSummary({
        id: summaryId,
        sessionId: "sess-1",
        turnRangeStart: "turn-1",
        turnRangeEnd: "turn-1",
        content: "x".repeat(3_000),
        focusSections: [],
        createdAt: new Date().toISOString(),
      });
      const after = await maybeCompact("sess-1", "", messages, deps, opts);
      expect(after.compacted).toBe(true);
      const taggedIds = (
        store.tagTurnMessagesCompacted as ReturnType<typeof vi.fn>
      ).mock.calls[0]![1] as string[];
      expect(taggedIds.every((id) => id.startsWith("fresh-"))).toBe(true);
    });
  });

  describe("LLM failure handling", () => {
    it("returns { compacted: false } and warns when fast LLM throws", async () => {
      const failingLlm: CompactorLLMAdapter = {
        complete: vi.fn(async () => {
          throw new Error("LLM unavailable");
        }),
      };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm: failingLlm,
        contextWindow: 1_000,
      };

      const result = await maybeCompact("sess-1", "", messages, deps);

      expect(result.compacted).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("LLM unavailable"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("locale", () => {
    it("uses zh-CN prompts when locale is zh-CN", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact("sess-1", "", messages, deps, { locale: "zh-CN" });

      const callArgs = (fastSlotLlm.complete as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as {
        systemPrompt: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(callArgs.systemPrompt).toMatch(/摘要/);
    });

    it("uses en-US prompts when locale is en-US", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact("sess-1", "", messages, deps, { locale: "en-US" });

      const callArgs = (fastSlotLlm.complete as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as {
        systemPrompt: string;
      };
      expect(callArgs.systemPrompt).toMatch(/summarizer/i);
    });

    it.each([
      [
        "zh-CN",
        /\[LANGUAGE\] 所有自然语言的摘要内容必须用简体中文（zh-CN）书写。$/,
      ],
      [
        "en-US",
        /\[LANGUAGE\] Write all natural-language summary content in .+ \(en-US\)\.$/,
      ],
      ["ru-RU", /\[LANGUAGE\] Всё содержание резюме .+ \(ru-RU\)\.$/],
      // No instruction set of its own: the English template and rule.
      [
        "zh-Hant-TW",
        /\[LANGUAGE\] Write all natural-language summary content in .+ \(zh-Hant-TW\)\.$/,
      ],
    ])(
      "writes the language rule in the language of the %s template",
      async (locale, rule) => {
        const deps: CompactorDeps = {
          store,
          estimator,
          fastSlotLlm,
          contextWindow: 1_000,
        };
        await maybeCompact("sess-1", "", makeSimpleHistory(20), deps, {
          locale,
        });
        const { systemPrompt } = (
          fastSlotLlm.complete as ReturnType<typeof vi.fn>
        ).mock.calls[0]![0] as { systemPrompt: string };
        expect(systemPrompt).toMatch(rule);
        // One rule, in one language.
        expect(systemPrompt.match(/\[LANGUAGE\]/g)).toHaveLength(1);
      },
    );

    it("uses ru-RU prompts and localized default focus sections", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact(
        "sess-ru",
        "",
        messages.map((m) => ({ ...m, sessionId: "sess-ru" })),
        deps,
        { locale: "ru-RU" },
      );

      const callArgs = (fastSlotLlm.complete as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as {
        systemPrompt: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(callArgs.systemPrompt).toContain("Ключевые события");
      expect(callArgs.messages[0]!.content).toContain("Кратко изложи");
    });
  });

  describe("prompt externalization (loadPrompt)", () => {
    let tmpRoot: string;

    beforeAll(async () => {
      tmpRoot = await mkdtemp(path.join(tmpdir(), "covel-compactor-prompts-"));
      const serverDir = path.join(tmpRoot, "server");
      await mkdir(serverDir, { recursive: true });
      await writeFile(
        path.join(serverDir, "compactor.zh.md"),
        "【ZH-FIXTURE】摘要器\n\nsections:\n- {{ sections }}\n",
      );
      await writeFile(
        path.join(serverDir, "compactor.en.md"),
        "<<EN-FIXTURE>> summarizer\n\nsections:\n- {{ sections }}\n",
      );
      loadPrompt = createPromptLoader(tmpRoot);
    });

    afterAll(async () => {
      loadPrompt = createPromptLoader(defaultPromptsRoot);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("reads the zh-CN system prompt from prompts/server/compactor.zh.md", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact("sess-1", "", messages, deps, { locale: "zh-CN" });

      const callArgs = (fastSlotLlm.complete as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as {
        systemPrompt: string;
      };
      expect(callArgs.systemPrompt).toContain("【ZH-FIXTURE】");
    });

    it("reads the en-US system prompt from prompts/server/compactor.en.md", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact("sess-1", "", messages, deps, { locale: "en-US" });

      const callArgs = (fastSlotLlm.complete as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as {
        systemPrompt: string;
      };
      expect(callArgs.systemPrompt).toContain("<<EN-FIXTURE>>");
    });

    it("uses the registry English fallback for an unregistered locale", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact("sess-1", "", messages, deps, { locale: "ja-JP" });

      const callArgs = (fastSlotLlm.complete as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as {
        systemPrompt: string;
      };
      expect(callArgs.systemPrompt).toContain("<<EN-FIXTURE>>");
      expect(callArgs.systemPrompt).toContain("日本語");
      expect(callArgs.systemPrompt).toContain("ja-JP");
    });

    it("does not use a Simplified Chinese short-key prompt for zh-Hant", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact("sess-1", "", messages, deps, {
        locale: "zh-Hant-TW",
      });

      const callArgs = (fastSlotLlm.complete as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as { systemPrompt: string };
      expect(callArgs.systemPrompt).toContain("<<EN-FIXTURE>>");
      expect(callArgs.systemPrompt).not.toContain("【ZH-FIXTURE】");
      expect(callArgs.systemPrompt).toContain("zh-Hant-TW");
    });

    it("rejects a path-like locale before constructing prompt paths", async () => {
      await expect(
        loadPrompt("server", "compactor", "x/../../../README"),
      ).rejects.toThrow("Invalid locale");
    });

    it("interpolates focusSections into the {{ sections }} template variable", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact("sess-1", "", messages, deps, {
        locale: "en-US",
        focusSections: ["alpha", "bravo", "charlie"],
      });

      const callArgs = (fastSlotLlm.complete as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as {
        systemPrompt: string;
      };
      // First section sits next to the leading "- " in the template; the rest
      // are joined with "\n- " so each appears on its own bullet line.
      expect(callArgs.systemPrompt).toContain("- alpha\n- bravo\n- charlie");
    });

    it("skips compaction when the prompt file is missing", async () => {
      // Point at an empty directory so loadPrompt() throws.
      const emptyRoot = await mkdtemp(
        path.join(tmpdir(), "covel-compactor-empty-"),
      );
      loadPrompt = createPromptLoader(emptyRoot);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const messages = makeSimpleHistory(20);
        const deps: CompactorDeps = {
          store,
          estimator,
          fastSlotLlm,
          contextWindow: 1_000,
        };

        const result = await maybeCompact("sess-1", "", messages, deps, {
          locale: "zh-CN",
        });

        expect(result.compacted).toBe(false);
        expect(fastSlotLlm.complete).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Failed to load prompt template"),
        );
      } finally {
        warnSpy.mockRestore();
        loadPrompt = createPromptLoader(tmpRoot);
        await rm(emptyRoot, { recursive: true, force: true });
      }
    });
  });

  describe("focusSections", () => {
    it("includes focusSections in the saved summary record", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact("sess-1", "", messages, deps, {
        focusSections: ["world-state", "quests"],
      });

      const saved = (store.saveSessionSummary as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SessionSummaryRecord;
      expect(saved.focusSections).toEqual(["world-state", "quests"]);
    });

    it("includes focusSections in the LLM system prompt", async () => {
      const messages = makeSimpleHistory(20);
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      await maybeCompact("sess-1", "", messages, deps, {
        focusSections: ["combat-log"],
        locale: "en-US",
      });

      const callArgs = (fastSlotLlm.complete as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as {
        systemPrompt: string;
      };
      expect(callArgs.systemPrompt).toContain("combat-log");
    });
  });
});

describe("segmented history persistence", () => {
  const estimator = makeEstimator();
  const options = {
    threshold: 0,
    protectLastNUserTurns: 0,
    protectLastNMessages: 0,
    locale: "en-US",
  };
  async function fixture(count: number) {
    const store = createMemoryStore();
    for (let index = 0; index < count; index++) {
      await store.saveSessionSummary({
        id: `summary-${index}`,
        sessionId: "sess-1",
        turnRangeStart: `old-turn-${index}`,
        turnRangeEnd: `old-turn-${index}`,
        content: `Preserved event ${index}.`,
        focusSections: [`focus-${index}`],
        createdAt: new Date(index).toISOString(),
      });
      await store.appendTurnMessage(
        makeTurnMessage(
          `old-${index}`,
          "assistant",
          `Original event ${index}`,
          {
            turnId: `old-turn-${index}`,
            compactedAtTurnId: `summary-${index}`,
            createdAt: new Date(index).toISOString(),
          },
        ),
      );
    }
    await store.appendTurnMessage(
      makeTurnMessage("fresh", "user", "New adventure. ".repeat(100), {
        turnId: "fresh-turn",
        createdAt: new Date(100).toISOString(),
      }),
    );
    return store;
  }

  it("merges only the oldest two segments at the eight-segment bound", async () => {
    const store = await fixture(8);
    const before = await store.listSessionSummaries("sess-1");
    const complete = vi.fn(
      async (request: Parameters<CompactorLLMAdapter["complete"]>[0]) => ({
        content: request.messages[0]!.content.includes(
          "selected_history_summaries",
        )
          ? "Merged events zero and one."
          : "Fresh event.",
      }),
    );
    const result = await maybeCompact(
      "sess-1",
      "",
      await store.listTurnMessages("sess-1"),
      {
        store,
        estimator,
        fastSlotLlm: { complete },
        contextWindow: 10_000,
      },
      options,
    );
    expect(result.compacted).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![0].messages[0]!.content).toContain(
      "Preserved event 0.",
    );
    expect(complete.mock.calls[1]![0].messages[0]!.content).toContain(
      "Preserved event 1.",
    );
    expect(complete.mock.calls[1]![0].messages[0]!.content).not.toContain(
      "Preserved event 2.",
    );
    const after = await store.listSessionSummaries("sess-1");
    expect(after).toHaveLength(8);
    expect(after[0]).toMatchObject({
      id: "summary-0",
      turnRangeStart: "old-turn-0",
      turnRangeEnd: "old-turn-1",
      createdAt: before[0]!.createdAt,
    });
    expect(after.slice(1, 7)).toEqual(before.slice(2));
    const messages = await store.listTurnMessages("sess-1");
    expect(messages.find((m) => m.id === "old-1")?.compactedAtTurnId).toBe(
      "summary-0",
    );
    expect(messages.find((m) => m.id === "old-2")?.compactedAtTurnId).toBe(
      "summary-2",
    );
    expect(messages.find((m) => m.id === "fresh")?.compactedAtTurnId).toBe(
      result.summaryId,
    );
  });

  it("bounds the aggregate when both LLM responses exceed their allocations", async () => {
    const store = await fixture(3);
    await maybeCompact(
      "sess-1",
      "",
      await store.listTurnMessages("sess-1"),
      {
        store,
        estimator,
        inputWindow: 10_000,
        contextWindow: 1_000,
        fastSlotLlm: makeFastLlm("Oversized output. ".repeat(1_000)),
      },
      options,
    );
    const summaries = await store.listSessionSummaries("sess-1");
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    expect(
      summaries.reduce((n, s) => n + estimator(s.content), 0),
    ).toBeLessThanOrEqual(128);
    expect(summaries.every((s) => estimator(s.content) <= 128)).toBe(true);
  });

  it("rolls back selective replacement if retagging fails", async () => {
    const store = await fixture(8);
    const summaries = await store.listSessionSummaries("sess-1");
    const messages = await store.listTurnMessages("sess-1");
    const failingStore: DataStore = {
      ...store,
      withTransaction: (fn) =>
        store.withTransaction((tx) =>
          fn({
            ...tx,
            retagCompactedTurnMessages: async () => {
              throw new Error("retag failed");
            },
          }),
        ),
    };
    await expect(
      maybeCompact(
        "sess-1",
        "",
        messages,
        {
          store: failingStore,
          estimator,
          contextWindow: 10_000,
          fastSlotLlm: makeFastLlm(),
        },
        options,
      ),
    ).rejects.toThrow("retag failed");
    expect(await store.listSessionSummaries("sess-1")).toEqual(summaries);
    expect(await store.listTurnMessages("sess-1")).toEqual(messages);
  });

  it.each([
    { messageIds: ["fresh"], replacesSummaryIds: ["foreign"] },
    { messageIds: [], replacesSummaryIds: ["summary-1"] },
    { messageIds: [], replacesSummaryIds: ["foreign"] },
    { messageIds: [], replacesSummaryIds: ["summary-0", "summary-0"] },
    { messageIds: ["foreign"], replacesSummaryIds: [] },
    { messageIds: ["fresh", "fresh"], replacesSummaryIds: [] },
  ])(
    "rejects invalid source selection before persistence: %j",
    async (selection) => {
      const store = await fixture(3);
      const summaries = await store.listSessionSummaries("sess-1");
      const messages = await store.listTurnMessages("sess-1");
      await expect(
        applyCompaction(
          "sess-1",
          "",
          messages,
          {
            store,
            estimator,
            contextWindow: 10_000,
            compact: async () => ({
              summaries: [
                {
                  ...selection,
                  content: "Untrusted summary",
                  focusSections: [],
                },
              ],
            }),
          },
          { threshold: 0 },
        ),
      ).rejects.toThrow("Invalid history compaction result");
      expect(await store.listSessionSummaries("sess-1")).toEqual(summaries);
      expect(await store.listTurnMessages("sess-1")).toEqual(messages);
    },
  );

  it("rejects provider output exceeding the aggregate summary budget", async () => {
    const store = await fixture(3);
    const before = await store.listSessionSummaries("sess-1");
    const messages = await store.listTurnMessages("sess-1");
    await expect(
      applyCompaction(
        "sess-1",
        "",
        messages,
        {
          store,
          estimator,
          contextWindow: 1_000,
          compact: async () => ({
            summaries: [
              {
                messageIds: ["fresh"],
                replacesSummaryIds: [],
                content: "x".repeat(128 * 4),
                focusSections: [],
              },
            ],
          }),
        },
        { threshold: 0 },
      ),
    ).rejects.toThrow("Invalid history compaction result");
    expect(await store.listSessionSummaries("sess-1")).toEqual(before);
    expect(await store.listTurnMessages("sess-1")).toEqual(messages);
  });

  it("refuses a stale provider result when summaries changed during generation", async () => {
    const store = await fixture(3);
    const before = await store.listSessionSummaries("sess-1");
    const messages = await store.listTurnMessages("sess-1");
    await expect(
      applyCompaction(
        "sess-1",
        "",
        messages,
        {
          store,
          estimator,
          contextWindow: 10_000,
          compact: async () => {
            await store.saveSessionSummary({
              ...before[0]!,
              id: "concurrent",
              createdAt: new Date(50).toISOString(),
            });
            return {
              summaries: [
                {
                  messageIds: ["fresh"],
                  replacesSummaryIds: [],
                  content: "fresh summary",
                  focusSections: [],
                },
              ],
            };
          },
        },
        { threshold: 0 },
      ),
    ).rejects.toThrow("History summaries changed during compaction");
    expect(await store.listSessionSummaries("sess-1")).toHaveLength(4);
    expect(await store.listTurnMessages("sess-1")).toEqual(messages);
  });

  it("keeps summary requests inside the fast input capacity and leaves the rest raw", async () => {
    const store = createMemoryStore();
    const messages = makeSimpleHistory(20);
    for (const message of messages) await store.appendTurnMessage(message);
    const complete = vi.fn<CompactorLLMAdapter["complete"]>(async () => ({
      content: "Bounded new segment",
    }));
    await maybeCompact(
      "sess-1",
      "",
      messages,
      {
        store,
        estimator,
        contextWindow: 1_000,
        inputWindow: 1_000,
        fastSlotLlm: { complete },
      },
      options,
    );
    const request = complete.mock.calls[0]?.[0] as
      Parameters<CompactorLLMAdapter["complete"]>[0] | undefined;
    expect(request).toBeDefined();
    expect(
      estimator(request!.systemPrompt) +
        estimator(request!.messages[0]!.content),
    ).toBeLessThanOrEqual(1_000);
    const raw = await store.listUncompactedTurnMessages("sess-1");
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.length).toBeLessThan(messages.length);
  });

  it("leaves an individually oversized source message uncompacted", async () => {
    const store = createMemoryStore();
    const message = makeTurnMessage("huge", "user", "x".repeat(100_000));
    await store.appendTurnMessage(message);
    const llm = makeFastLlm();
    const result = await maybeCompact(
      "sess-1",
      "",
      [message],
      {
        store,
        estimator,
        contextWindow: 1_000,
        fastSlotLlm: llm,
      },
      options,
    );
    expect(result.compacted).toBe(false);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(await store.listSessionSummaries("sess-1")).toEqual([]);
    expect(await store.listUncompactedTurnMessages("sess-1")).toEqual([
      message,
    ]);
  });
});
