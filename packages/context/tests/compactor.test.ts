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
import { maybeCompact } from "../src/compactor.js";
import type { CompactorDeps, CompactorLLMAdapter } from "../src/compactor.js";
import { setPromptsRoot } from "../src/prompts-loader.js";
import type {
  DataStore,
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
      ),
    );
  }
  return msgs;
}

function makeMinimalStore(): DataStore {
  const summaries: SessionSummaryRecord[] = [];
  const messages = new Map<string, TurnMessageRecord>();

  return {
    saveSessionSummary: vi.fn(async (s: SessionSummaryRecord) => {
      summaries.push(s);
    }),
    listSessionSummaries: vi.fn(async () => [...summaries]),
    deleteSessionSummaries: vi.fn(async () => {}),
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
    addTraceEvent: vi.fn(async () => {}),
  } as unknown as DataStore;
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

      await maybeCompact("sess-focus", "", messages, deps, {
        focusSections: ["narrative", "character-state"],
      });

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
    });

    it("does not re-compact when nothing new arrived since the last round", async () => {
      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
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
      setPromptsRoot(tmpRoot);
    });

    afterAll(async () => {
      setPromptsRoot(null);
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
      setPromptsRoot(emptyRoot);
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
        setPromptsRoot(tmpRoot);
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
