import { describe, it, expect } from "vitest";
import {
  createMockHandlerContext,
  createMockProviderInput,
  createCollectingRegistrar,
  findProposal,
  findProposals,
  assertProposalContains,
} from "@covel/plugin-test-utils";
import {
  buildSummaryPrompt,
  parseSummaryResponse,
  buildMemoryProposals,
  formatMemoryContext,
} from "../server/logic.js";
import type { MemoryArchive, ParsedSummaryResponse } from "../server/logic.js";
import register from "../server/index.js";

// ── buildSummaryPrompt ──────────────────────────────────────────

describe("buildSummaryPrompt", () => {
  it("builds a Chinese prompt when locale is zh-CN", () => {
    const prompt = buildSummaryPrompt(
      "勇者进入了黑暗森林",
      "之前的摘要内容",
      [{ type: "quest.start", payload: "找到失落的圣剑" }],
      "zh-CN"
    );

    expect(prompt).toContain("记忆管理者");
    expect(prompt).toContain("之前的摘要内容");
    expect(prompt).toContain("勇者进入了黑暗森林");
    expect(prompt).toContain("quest.start");
    expect(prompt).toContain("找到失落的圣剑");
  });

  it("builds an English prompt when locale is en-US", () => {
    const prompt = buildSummaryPrompt(
      "The hero entered the dark forest",
      "Previous summary",
      [{ type: "quest.start", payload: "Find the lost sword" }],
      "en-US"
    );

    expect(prompt).toContain("memory manager");
    expect(prompt).toContain("Previous summary");
    expect(prompt).toContain("The hero entered the dark forest");
    expect(prompt).toContain("quest.start");
  });

  it("handles missing existing summary", () => {
    const prompt = buildSummaryPrompt(
      "Some narrative",
      undefined,
      [],
      "en-US"
    );

    expect(prompt).toContain("None");
    expect(prompt).toContain("first summary");
  });

  it("handles empty events array", () => {
    const prompt = buildSummaryPrompt(
      "Some narrative",
      "Existing summary",
      [],
      "en-US"
    );

    expect(prompt).toContain("No recent events");
  });

  it("formats event payloads that are objects", () => {
    const prompt = buildSummaryPrompt(
      "Narrative",
      undefined,
      [{ type: "item.acquired", payload: { item: "sword", qty: 1 } }],
      "en-US"
    );

    expect(prompt).toContain("item.acquired");
    expect(prompt).toContain("sword");
  });
});

// ── parseSummaryResponse ────────────────────────────────────────

describe("parseSummaryResponse", () => {
  it("parses valid JSON response", () => {
    const input = JSON.stringify({
      summary: "The hero found the sword.",
      keyEvents: ["Hero defeated the dragon", "Village was saved"],
    });

    const result = parseSummaryResponse(input);

    expect(result.summary).toBe("The hero found the sword.");
    expect(result.keyEvents).toEqual([
      "Hero defeated the dragon",
      "Village was saved",
    ]);
  });

  it("handles JSON wrapped in markdown code fences", () => {
    const input = `\`\`\`json
{
  "summary": "A summary",
  "keyEvents": ["Event one"]
}
\`\`\``;

    const result = parseSummaryResponse(input);

    expect(result.summary).toBe("A summary");
    expect(result.keyEvents).toEqual(["Event one"]);
  });

  it("handles plain code fences without language tag", () => {
    const input = `\`\`\`
{"summary": "Test summary", "keyEvents": []}
\`\`\``;

    const result = parseSummaryResponse(input);

    expect(result.summary).toBe("Test summary");
    expect(result.keyEvents).toEqual([]);
  });

  it("falls back to raw text when JSON is invalid", () => {
    const input = "This is not JSON at all, just a plain text summary.";

    const result = parseSummaryResponse(input);

    expect(result.summary).toBe(input);
    expect(result.keyEvents).toEqual([]);
  });

  it("filters non-string key events", () => {
    const input = JSON.stringify({
      summary: "Summary",
      keyEvents: ["Valid event", 42, null, "Another valid"],
    });

    const result = parseSummaryResponse(input);

    expect(result.keyEvents).toEqual(["Valid event", "Another valid"]);
  });

  it("handles missing keyEvents field", () => {
    const input = JSON.stringify({ summary: "Just a summary" });

    const result = parseSummaryResponse(input);

    expect(result.summary).toBe("Just a summary");
    expect(result.keyEvents).toEqual([]);
  });

  it("handles non-object JSON (e.g., a string)", () => {
    const input = JSON.stringify("just a string");

    const result = parseSummaryResponse(input);

    // Falls back to using the trimmed input as summary
    expect(result.summary).toBe('"just a string"');
    expect(result.keyEvents).toEqual([]);
  });
});

// ── buildMemoryProposals ────────────────────────────────────────

describe("buildMemoryProposals", () => {
  it("builds state.patch with incremented version", () => {
    const parsed: ParsedSummaryResponse = {
      summary: "Updated summary",
      keyEvents: [],
    };

    const proposals = buildMemoryProposals(parsed, "turn_005", 2);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe("state.patch");

    const payload = proposals[0]!.payload as {
      memoryArchive: MemoryArchive;
    };
    expect(payload.memoryArchive.summary).toBe("Updated summary");
    expect(payload.memoryArchive.version).toBe(3);
    expect(payload.memoryArchive.lastTurnId).toBe("turn_005");
  });

  it("adds record.upsert for each key event", () => {
    const parsed: ParsedSummaryResponse = {
      summary: "Summary",
      keyEvents: ["Event A", "Event B"],
    };

    const proposals = buildMemoryProposals(parsed, "turn_010", 5);

    expect(proposals).toHaveLength(3);
    expect(proposals[0]!.kind).toBe("state.patch");
    expect(proposals[1]!.kind).toBe("record.upsert");
    expect(proposals[2]!.kind).toBe("record.upsert");

    const record1 = proposals[1]!.payload as {
      type: string;
      content: string;
      version: number;
    };
    expect(record1.type).toBe("memory.key_event");
    expect(record1.content).toBe("Event A");
    expect(record1.version).toBe(6);

    const record2 = proposals[2]!.payload as {
      type: string;
      content: string;
    };
    expect(record2.content).toBe("Event B");
  });

  it("starts from version 1 when current version is 0", () => {
    const parsed: ParsedSummaryResponse = {
      summary: "First summary",
      keyEvents: [],
    };

    const proposals = buildMemoryProposals(parsed, "turn_001", 0);

    const payload = proposals[0]!.payload as {
      memoryArchive: MemoryArchive;
    };
    expect(payload.memoryArchive.version).toBe(1);
  });
});

// ── formatMemoryContext ─────────────────────────────────────────

describe("formatMemoryContext", () => {
  it("formats a valid archive", () => {
    const archive: MemoryArchive = {
      summary: "The hero ventured forth.",
      version: 3,
      lastTurnId: "turn_015",
    };

    const result = formatMemoryContext(archive);

    expect(result).toBe("[Memory Archive v3]\nThe hero ventured forth.");
  });

  it("returns empty string for null archive", () => {
    expect(formatMemoryContext(null)).toBe("");
  });

  it("returns empty string for undefined archive", () => {
    expect(formatMemoryContext(undefined)).toBe("");
  });

  it("returns empty string for archive without summary", () => {
    expect(formatMemoryContext({ version: 1 })).toBe("");
  });

  it("returns empty string for archive with empty summary", () => {
    expect(formatMemoryContext({ summary: "", version: 1 })).toBe("");
  });

  it("defaults version to 0 when missing", () => {
    const result = formatMemoryContext({ summary: "Some text" });

    expect(result).toBe("[Memory Archive v0]\nSome text");
  });

  it("trims whitespace from summary", () => {
    const result = formatMemoryContext({
      summary: "  Padded summary  ",
      version: 2,
    });

    expect(result).toBe("[Memory Archive v2]\nPadded summary");
  });
});

// ── Plugin Registration ─────────────────────────────────────────

describe("register", () => {
  it("registers a runtime handler and context provider", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    register(registrar);

    expect(contributions.runtimeHandlers.has("memory-summarizer")).toBe(true);
    expect(contributions.contextProviders.has("memory-archive")).toBe(true);
    expect(contributions.tools.size).toBe(0);
    expect(contributions.hooks.size).toBe(0);
  });
});

// ── memorySummarizerHandler (integration with mock LLM) ─────────

describe("memorySummarizerHandler", () => {
  it("generates proposals from narrative using mock LLM", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("memory-summarizer")!;

    const mockResponse = JSON.stringify({
      summary: "The hero entered the forest and found a magical sword.",
      keyEvents: ["Hero found the Sword of Light"],
    });

    const ctx = createMockHandlerContext({
      contextOverrides: {
        narrative: {
          content: "A long narrative about the hero entering the forest...",
          messageId: "msg_100",
        },
        state: {
          memoryArchive: {
            summary: "Previous events summary.",
            version: 2,
            lastTurnId: "turn_008",
          },
        },
        events: [
          { type: "item.found" as unknown as undefined },
        ],
        run: {
          runId: "run_001",
          worldId: "world_001",
          branchId: "branch_main",
          turnId: "turn_010",
          status: "active",
          phase: "playing",
          defaultLocale: "zh-CN",
          activeBranchId: "branch_main",
        },
      },
      generateTextImpl: async () => mockResponse,
    });

    const result = await handler(ctx);

    assertProposalContains(result.proposals, [
      "state.patch",
      "record.upsert",
    ]);

    const statePatch = findProposal<{ memoryArchive: MemoryArchive }>(
      result.proposals,
      "state.patch"
    );
    expect(statePatch?.memoryArchive.summary).toBe(
      "The hero entered the forest and found a magical sword."
    );
    expect(statePatch?.memoryArchive.version).toBe(3);

    const records = findProposals<{ type: string; content: string }>(
      result.proposals,
      "record.upsert"
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.content).toBe("Hero found the Sword of Light");
  });

  it("returns empty proposals when no narrative and no events", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("memory-summarizer")!;

    const ctx = createMockHandlerContext({
      contextOverrides: {
        narrative: { content: "", messageId: "msg_001" },
        events: [],
      },
      generateTextImpl: async () => "should not be called",
    });

    const result = await handler(ctx);

    expect(result.proposals).toEqual([]);
  });

  it("returns empty proposals when generateText is not available", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("memory-summarizer")!;

    const ctx = createMockHandlerContext({
      contextOverrides: {
        narrative: {
          content: "Some narrative content",
          messageId: "msg_001",
        },
      },
    });

    // Remove generateText
    const ctxWithoutLLM = { ...ctx, generateText: undefined };

    const result = await handler(ctxWithoutLLM);

    expect(result.proposals).toEqual([]);
  });

  it("returns empty proposals when LLM throws", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("memory-summarizer")!;

    const ctx = createMockHandlerContext({
      contextOverrides: {
        narrative: {
          content: "Some narrative",
          messageId: "msg_001",
        },
      },
      generateTextImpl: async () => {
        throw new Error("LLM unavailable");
      },
    });

    const result = await handler(ctx);

    expect(result.proposals).toEqual([]);
  });

  it("handles first summarization with no existing archive", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("memory-summarizer")!;

    const mockResponse = JSON.stringify({
      summary: "First summary of the adventure.",
      keyEvents: [],
    });

    const ctx = createMockHandlerContext({
      contextOverrides: {
        narrative: {
          content: "The adventure begins in a small village.",
          messageId: "msg_001",
        },
        state: {},
        run: {
          runId: "run_001",
          worldId: "world_001",
          branchId: "branch_main",
          turnId: "turn_005",
          status: "active",
          phase: "playing",
          defaultLocale: "zh-CN",
          activeBranchId: "branch_main",
        },
      },
      generateTextImpl: async () => mockResponse,
    });

    const result = await handler(ctx);

    expect(result.proposals).toHaveLength(1);
    const patch = findProposal<{ memoryArchive: MemoryArchive }>(
      result.proposals,
      "state.patch"
    );
    expect(patch?.memoryArchive.version).toBe(1);
    expect(patch?.memoryArchive.summary).toBe(
      "First summary of the adventure."
    );
  });
});

// ── memoryContextProvider ───────────────────────────────────────

describe("memoryContextProvider", () => {
  it("returns formatted archive when state has memoryArchive", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("memory-archive")!;

    const input = createMockProviderInput({
      state: {
        memoryArchive: {
          summary: "The hero saved the village.",
          version: 5,
          lastTurnId: "turn_025",
        },
      },
    });

    const result = (await provider(input)) as {
      title: string;
      content: string;
      priority: number;
    };

    expect(result.title).toBe("Memory Archive");
    expect(result.content).toContain("Memory Archive v5");
    expect(result.content).toContain("The hero saved the village.");
    expect(result.priority).toBe(80);
  });

  it("returns null when no archive exists", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("memory-archive")!;

    const input = createMockProviderInput({ state: {} });

    const result = await provider(input);

    expect(result).toBeNull();
  });

  it("returns null when state is undefined", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("memory-archive")!;

    const input = createMockProviderInput({ state: undefined });

    const result = await provider(input);

    expect(result).toBeNull();
  });
});
