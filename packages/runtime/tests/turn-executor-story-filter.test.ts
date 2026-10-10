/**
 * Tests for the agent-runtime history filter — structured-output detection
 * (markdown-fenced / backtick-wrapped JSON, tool tags) and the per-runtime
 * history filter that keeps prose + own output while dropping other plugins'
 * structured tool output.
 */

import { describe, it, expect } from "vitest";
import { looksLikeStructuredRuntimeOutput } from "../src/turn-executor/turn-executor.js";
import {
  applyHistoryWindow,
  filterRuntimeHistory,
} from "../src/agent-loop/message-filter.js";
import {
  attachRuntimeJournal,
  collectExecutionJournal,
  collectExecutionTriggers,
} from "../src/execution-journal.js";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import type { TurnMessageRecord } from "@covel/store";

function msg(
  sourceType: "player" | "system" | "runtime",
  content: string,
  sourceRuntimeId?: string,
): TurnMessageRecord {
  return { sourceType, content, sourceRuntimeId } as TurnMessageRecord;
}

describe("looksLikeStructuredRuntimeOutput", () => {
  it.each([
    ["empty", "", false],
    ["whitespace only", "   \n  ", false],
    ["prose", "你深吸一口气，坊市角落的灵气光点随着呼吸微微颤动。", false],
    ["raw object", '{"narrativeOutput":"x"}', true],
    ["raw array", "[1,2,3]", true],
    ["markdown json", '```json\n{"topic":"x"}\n```', true],
    ["markdown json upper", '```JSON\n{"topic":"x"}\n```', true],
    ["markdown ts", "```ts\n{ foo: 1 }\n```", true],
    ["markdown bare fence", '```\n{"topic":"x"}\n```', true],
    ["backtick-wrapped json", '`{"a":1}`', true],
    ["prose ending in brace", "你赢了}", false],
    ["tool tag", '<tool-call name="x">...</tool-call>', true],
    ["tool tag uppercase", "<TOOL>foo</TOOL>", true],
    ["prose that mentions json", "叙事里提到 JSON 格式的东西", false],
  ])("%s", (_name, input, expected) => {
    expect(looksLikeStructuredRuntimeOutput(input)).toBe(expected);
  });

  it("handles null / undefined defensively", () => {
    expect(looksLikeStructuredRuntimeOutput(undefined)).toBe(false);
    expect(looksLikeStructuredRuntimeOutput(null)).toBe(false);
  });
});

describe("filterRuntimeHistory (applies to every agent runtime)", () => {
  const history: TurnMessageRecord[] = [
    msg("player", "我走进坊市。"),
    msg("system", "🌍 欢迎"),
    msg("runtime", "坊市的灯火次第亮起。", "chat-mode-narrator"), // other runtime, prose → keep
    msg("runtime", '{"entries":[{"id":"codex-1"}]}', "codex"), // other runtime, JSON → drop
    msg("runtime", '[{"id":"npc-1"}]', "npc-graph/extractor"), // other runtime, JSON → drop
    msg("runtime", '{"characters":[]}', "char-creator/character-tracker"), // OWN output → keep
  ];

  it("drops other plugins' structured JSON but keeps player/system/narrative/own output for a non-story runtime", () => {
    const kept = filterRuntimeHistory(
      history,
      "char-creator/character-tracker",
    );
    const contents = kept.map((m) => m.content);
    // player + system + other-runtime prose + own JSON output survive
    expect(contents).toContain("我走进坊市。");
    expect(contents).toContain("🌍 欢迎");
    expect(contents).toContain("坊市的灯火次第亮起。");
    expect(contents).toContain('{"characters":[]}'); // own output kept even though JSON
    // other plugins' structured JSON is dropped
    expect(contents).not.toContain('{"entries":[{"id":"codex-1"}]}');
    expect(contents).not.toContain('[{"id":"npc-1"}]');
  });

  it("treats own structured output as own-output (kept), other plugins' as droppable", () => {
    // A narrative-like message from any runtime is kept — only structured JSON
    // from OTHER runtimes is dropped.
    const kept = filterRuntimeHistory(history, "codex");
    // codex now views its OWN JSON as own-output (kept); the extractor JSON is
    // still dropped as another plugin's structured output.
    const contents = kept.map((m) => m.content);
    expect(contents).toContain('{"entries":[{"id":"codex-1"}]}'); // own output
    expect(contents).not.toContain('[{"id":"npc-1"}]'); // other plugin JSON
  });
});

describe("applyHistoryWindow", () => {
  const turn = (turnId: string, content: string): TurnMessageRecord =>
    ({ turnId, sourceType: "player", content }) as TurnMessageRecord;
  const history = [
    turn("t1", "one"),
    turn("t2", "two-player"),
    turn("t2", "two-narrator"),
    turn("t3", "three"),
  ];

  it("keeps whole turns, newest first", () => {
    expect(
      applyHistoryWindow(history, { maxTurns: 2 }).map((m) => m.content),
    ).toEqual(["two-player", "two-narrator", "three"]);
  });

  it("returns no history for maxTurns 0 and everything for a large window", () => {
    expect(applyHistoryWindow(history, { maxTurns: 0 })).toEqual([]);
    expect(applyHistoryWindow(history, { maxTurns: 10 })).toEqual(history);
  });
});

describe("runtime journal content", () => {
  const journal = (output: Record<string, unknown>) => {
    const result = {
      pluginId: "p",
      runtimeId: "p/r",
      runId: "run",
      turnId: "t",
      status: "success",
      output,
      toolCalls: [],
      durationMs: 0,
      timestamp: "2024-01-01T00:00:00Z",
    } as RuntimeResult;
    attachRuntimeJournal(
      result,
      { origin: "player", sessionId: "s", turnId: "t", playerMessage: "hi" },
      {
        name: "p/r",
        pluginId: "p",
        description: "",
        stage: "post-turn",
      } as RuntimeManifest,
      output,
    );
    return {
      contents: collectExecutionJournal({ runtimeResults: [result] }).map(
        (message) => message.content,
      ),
      triggers: collectExecutionTriggers({ runtimeResults: [result] }),
    };
  };

  it("records text outputs and counts structured outputs without a row", () => {
    expect(journal({ narrativeOutput: "The door opens." })).toEqual({
      contents: ["The door opens."],
      triggers: ["p/r"],
    });
    expect(journal({ content: "Two facts saved." }).contents).toEqual([
      "Two facts saved.",
    ]);
    expect(journal({ storm: { value: 3 }, grid: { value: 1 } })).toEqual({
      contents: [],
      triggers: ["p/r"],
    });
  });

  it("drops empty runtime rows from agent history", () => {
    const kept = filterRuntimeHistory(
      [
        msg("player", "look"),
        msg("runtime", "", "world-init/dimension-context"),
      ],
      "codex",
    );
    expect(kept.map((m) => m.content)).toEqual(["look"]);
  });
});
