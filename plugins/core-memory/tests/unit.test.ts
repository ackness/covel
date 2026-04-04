import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  createMockProviderInput,
  createCollectingRegistrar,
} from "@covel/plugin-test-utils";
import { validateManifest } from "@covel/plugin-runtime";
import type { ToolExecutionContext } from "@covel/shared";
import { formatMemoryContext } from "../server/logic.js";
import type { MemoryArchive } from "../server/logic.js";
import register from "../server/index.js";

// ── plugin.json manifest ────────────────────────────────────────

describe("plugin.json manifest", () => {
  it("passes schema validation", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

// ── Plugin Registration ─────────────────────────────────────────

describe("register", () => {
  it("registers tools and context provider (no runtime handler)", () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    expect(contributions.tools.has("update-memory-archive")).toBe(true);
    expect(contributions.tools.has("record-key-event")).toBe(true);
    expect(contributions.contextProviders.has("memory-archive")).toBe(true);
    expect(contributions.runtimeHandlers.size).toBe(0);
  });
});

// ── update-memory-archive tool ──────────────────────────────────

describe("update-memory-archive tool", () => {
  function getToolHandler() {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    return contributions.tools.get("update-memory-archive")!;
  }

  function makeCtx(
    input: Record<string, unknown>,
    state?: Record<string, unknown>,
  ): ToolExecutionContext {
    return {
      input,
      locale: "zh-CN",
      state: {
        turnId: "turn_010",
        ...state,
      },
    } as ToolExecutionContext;
  }

  it("creates first memory archive (version 1)", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx({
      summary: "勇者进入了黑暗森林，发现了一把神剑。",
    }));

    expect(result.output).toEqual(expect.objectContaining({
      message: expect.any(String),
      version: 1,
    }));

    const statePatch = result.proposals!.find((p) => p.kind === "state.patch");
    expect(statePatch).toBeDefined();

    const payload = statePatch!.payload as { memoryArchive: MemoryArchive };
    expect(payload.memoryArchive.summary).toBe("勇者进入了黑暗森林，发现了一把神剑。");
    expect(payload.memoryArchive.version).toBe(1);
    expect(payload.memoryArchive.lastTurnId).toBe("turn_010");
  });

  it("increments version on existing archive", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx(
      { summary: "Updated summary." },
      {
        memoryArchive: {
          summary: "Old summary.",
          version: 3,
          lastTurnId: "turn_005",
        },
      },
    ));

    const payload = (result.proposals!.find((p) => p.kind === "state.patch")!
      .payload as { memoryArchive: MemoryArchive });
    expect(payload.memoryArchive.version).toBe(4);
    expect(payload.memoryArchive.summary).toBe("Updated summary.");
  });

  it("rejects empty summary", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx({ summary: "" }));

    expect(result.output).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
    expect(result.proposals).toBeUndefined();
  });
});

// ── record-key-event tool ───────────────────────────────────────

describe("record-key-event tool", () => {
  function getToolHandler() {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    return contributions.tools.get("record-key-event")!;
  }

  function makeCtx(
    input: Record<string, unknown>,
    state?: Record<string, unknown>,
  ): ToolExecutionContext {
    return {
      input,
      locale: "zh-CN",
      state: {
        turnId: "turn_010",
        ...state,
      },
    } as ToolExecutionContext;
  }

  it("emits record.upsert proposal for key event", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx({
      content: "勇者击败了恶龙。",
    }));

    expect(result.output).toEqual(expect.objectContaining({
      message: expect.any(String),
    }));

    const upsert = result.proposals!.find((p) => p.kind === "record.upsert");
    expect(upsert).toBeDefined();

    const payload = upsert!.payload as {
      key: string;
      value: { recordType: string; content: string; turnId: string };
    };
    expect(payload.value.recordType).toBe("memory.key_event");
    expect(payload.value.content).toBe("勇者击败了恶龙。");
    expect(payload.value.turnId).toBe("turn_010");
  });

  it("rejects empty content", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx({ content: "" }));

    expect(result.output).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));
    expect(result.proposals).toBeUndefined();
  });
});

// ── formatMemoryContext (unchanged) ─────────────────────────────

describe("formatMemoryContext", () => {
  it("formats a valid archive", () => {
    const archive: MemoryArchive = {
      summary: "The hero ventured forth.",
      version: 3,
      lastTurnId: "turn_015",
    };
    expect(formatMemoryContext(archive)).toBe("[Memory Archive v3]\nThe hero ventured forth.");
  });

  it("returns empty string for null/undefined/missing summary", () => {
    expect(formatMemoryContext(null)).toBe("");
    expect(formatMemoryContext(undefined)).toBe("");
    expect(formatMemoryContext({ version: 1 })).toBe("");
    expect(formatMemoryContext({ summary: "", version: 1 })).toBe("");
  });

  it("defaults version to 0 when missing", () => {
    expect(formatMemoryContext({ summary: "Some text" })).toBe("[Memory Archive v0]\nSome text");
  });

  it("trims whitespace from summary", () => {
    expect(formatMemoryContext({ summary: "  Padded  ", version: 2 }))
      .toBe("[Memory Archive v2]\nPadded");
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
    expect(result.priority).toBe(80);
  });

  it("returns null when no archive exists", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("memory-archive")!;
    const input = createMockProviderInput({ state: {} });

    expect(await provider(input)).toBeNull();
  });
});
