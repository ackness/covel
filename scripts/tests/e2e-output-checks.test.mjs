import { test } from "node:test";
import assert from "node:assert/strict";
import {
  languageVerdict,
  outputLanguageReport,
  promptLanguageReport,
  rejectedToolCalls,
} from "../lib/e2e-output-checks.mjs";

const responded = (runtimeId, toolCalls, text = "") => ({
  type: "llm.responded",
  payload: { runtimeId, text, toolCalls },
});
const call = (name, args) => ({ name, arguments: JSON.stringify(args) });

test("groups rejected tool calls by runtime, tool and error", () => {
  const failed = (error) => ({
    type: "tool.failed",
    payload: {
      runtimeId: "world-init/dimension-tracker",
      toolName: "update-dimensions",
      error,
    },
  });
  assert.deepEqual(
    rejectedToolCalls([
      failed("Invalid input: expected array, received string"),
      { type: "tool.completed", payload: { toolName: "update-dimensions" } },
      failed("Invalid input: expected array, received string"),
      failed('Unrecognized key: "reason"'),
    ]),
    [
      {
        runtimeId: "world-init/dimension-tracker",
        toolName: "update-dimensions",
        error: "Invalid input: expected array, received string",
        count: 2,
      },
      {
        runtimeId: "world-init/dimension-tracker",
        toolName: "update-dimensions",
        error: 'Unrecognized key: "reason"',
        count: 1,
      },
    ],
  );
});

test("counts English prose in a Chinese session and leaves identifiers out", () => {
  const facts = {
    entities: [
      {
        id: "tide-stone-mist-lamp",
        type: "item",
        name: "潮石雾灯",
        description:
          "Half hemp rope hanging from the iron post at the stair mouth",
      },
      {
        id: "su-yao",
        type: "character",
        name: "苏遥",
        description: "验潮师公会的新晋学徒，带着尚未出师的考核潮纹",
      },
    ],
    events: [
      {
        id: "player-examines-the-rope",
        description:
          "The player examines the rope and finds black salt crystals",
      },
    ],
  };
  const [row] = outputLanguageReport(
    [
      responded("world-ir", [
        call("submit-world-facts", facts),
        call("runtime-done", {
          reason: "Nothing else changed in this turn at all",
        }),
      ]),
    ],
    "zh-CN",
  );
  // Three prose values; the two English descriptions are wrong. The ids and
  // the trace note of runtime-done are not counted.
  assert.deepEqual([row.runtimeId, row.prose, row.wrong], ["world-ir", 3, 2]);
  assert.match(row.examples[0], /entities\[\]\.description = "Half hemp rope/);
});

test("counts Chinese prose in an English session", () => {
  const [row] = outputLanguageReport(
    [
      responded(
        "narrator",
        [],
        "The bell's third stroke still hangs over the harbour.",
      ),
      responded("narrator", [
        call("emit-event", {
          topic: "clue:found",
          data: { summary: "码头区边缘有通往干涸河床的石阶" },
        }),
      ]),
    ],
    "en-US",
  );
  assert.deepEqual([row.prose, row.wrong], [2, 1]);
});

test("fails a runtime only when the wrong-language share is beyond a stray value", () => {
  assert.equal(languageVerdict({ prose: 200, wrong: 0 }), "ok");
  assert.equal(languageVerdict({ prose: 227, wrong: 1 }), "warn");
  assert.equal(languageVerdict({ prose: 20, wrong: 4 }), "warn");
  assert.equal(languageVerdict({ prose: 224, wrong: 67 }), "fail");
  assert.equal(languageVerdict({ prose: 400, wrong: 6 }), "warn");
});

test("names the runtime whose prompt carries another script", () => {
  const calling = (runtimeId, content, extra = {}) => ({
    type: "llm.calling",
    payload: { runtimeId, messages: [{ role: "system", content }], ...extra },
  });
  const events = [
    // The same line in two calls counts once.
    calling(
      "codex",
      'Entries:\n- category: {"zh":"怪物","en":"Monsters"}\n- title: Fog hound',
    ),
    calling(
      "codex",
      'Entries:\n- category: {"zh":"怪物","en":"Monsters"}\n- title: Fog hound',
    ),
    calling("narrator", "Write the next scene.", {
      tools: [{ name: "note", description: "记录一条笔记" }],
    }),
    calling("plotter", "隐藏的剧情安排", { concealed: true }),
    calling("guide", "Suggest three actions."),
  ];

  assert.deepEqual(
    promptLanguageReport(events, "en-US").map((row) => [
      row.runtimeId,
      row.characters,
      row.lines,
    ]),
    [
      ["narrator", 6, 1],
      ["codex", 2, 1],
    ],
  );
  // English identifiers and tool definitions are expected in a Chinese session.
  assert.deepEqual(promptLanguageReport(events, "zh-CN"), []);
});
