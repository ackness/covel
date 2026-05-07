/**
 * Unit tests for the S2-T2 Compactor.
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

  describe("no cascade compaction", () => {
    it("skips compaction if any to-compact message is already tagged", async () => {
      const messages = makeSimpleHistory(20);
      // Tag an early message to simulate existing compaction
      (messages[0] as { compactedAtTurnId?: string }).compactedAtTurnId =
        "existing-summary";

      const deps: CompactorDeps = {
        store,
        estimator,
        fastSlotLlm,
        contextWindow: 1_000,
      };

      const result = await maybeCompact("sess-1", "", messages, deps);

      expect(result.compacted).toBe(false);
      expect(fastSlotLlm.complete).not.toHaveBeenCalled();
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
