import { test } from "node:test";
import assert from "node:assert/strict";
import {
  promptStyleFindings,
  structureDifferences,
} from "../lib/prompt-style.mjs";

const rules = (body) => promptStyleFindings(body).map((item) => item.rule);

test("accepts a body written in the contract style", () => {
  const body = `
You are the quest log. You record the quests that the story gives the player.

## Procedure

1. Find each quest that this turn gives, advances, completes or fails.
2. Call \`upsert-quests\` one time with all of them.

## Limits

- You must not add a quest that the narrative did not state.
`;
  assert.deepEqual(promptStyleFindings(body), []);
});

test("reports a long sentence, with a lower limit for a step", () => {
  const twentyTwo =
    "Read the narrative of this turn and then find every quest that the story gives to the player in the tavern scene.";
  assert.deepEqual(rules(twentyTwo), []);
  assert.deepEqual(rules(`- ${twentyTwo}`), ["sentence-length"]);
  assert.deepEqual(
    rules(`${twentyTwo.slice(0, -1)} and also every side quest and rumor.`),
    ["sentence-length"],
  );
});

test("counts each sentence of a list item on its own", () => {
  assert.deepEqual(
    rules(
      "- **Record a delta only for an explicit interaction in the narrative.** An NPC that only appears does not count",
    ),
    [],
  );
});

test("reports should, vague qualifiers and an output language", () => {
  assert.deepEqual(rules("The summary should be short."), ["should"]);
  assert.deepEqual(rules("Add tags as appropriate."), ["vague"]);
  assert.deepEqual(rules("Try to keep names short, etc."), ["vague", "vague"]);
  assert.deepEqual(rules("Always respond in Chinese."), ["output-language"]);
  assert.deepEqual(rules("Write it in the language of this story."), [
    "output-language",
  ]);
});

test("reports a word the prompt vocabulary replaces", () => {
  assert.deepEqual(rules("Do not change the hero's identity."), ["term"]);
  assert.deepEqual(rules("Ask the user for a name."), ["term"]);
  // A chat role is not the player.
  assert.deepEqual(rules("The user message contains JSON."), []);
});

test("reports a sentence that is stated twice", () => {
  const body = `
- A successful write ends the runtime at once.

Some other text.

- A successful write ends the runtime at once.
`;
  assert.deepEqual(rules(body), ["repeated"]);
  // Lines of identifiers are lists, not rules.
  assert.deepEqual(
    rules(
      "- `a`: `b`, `c`, `d`, `e`, `f`, `g`\n- `a`: `b`, `c`, `d`, `e`, `f`, `g`",
    ),
    [],
  );
});

test("does not read quotations, code or the voice zone", () => {
  assert.deepEqual(rules('A menu such as "You should:" is a violation.'), []);
  assert.deepEqual(
    rules("```\nYou should respond in Chinese as appropriate.\n```"),
    [],
  );
  const body = `
## Voice

The narration should feel unhurried, as appropriate for the hero's mood, and it can run to very long sentences that wander through the scene before they come to rest.

### Examples

It should not matter here either.

## Limits

This one should be reported.
`;
  assert.deepEqual(
    promptStyleFindings(body).map((item) => [item.line, item.rule]),
    [[12, "should"]],
  );
});

test("compares the structure of a body and its translation", () => {
  const english =
    "Intro.\n\n## Inputs\n\n- one\n- two\n\n| a |\n| - |\n| b |\n";
  assert.deepEqual(
    structureDifferences(
      english,
      "介绍。\n\n## 输入\n\n- 一\n- 二\n\n| a |\n| - |\n| b |\n",
    ),
    [],
  );
  assert.deepEqual(
    structureDifferences(
      english,
      "介绍。\n\n- 一\n- 二\n- 三\n\n| a |\n| - |\n| b |\n",
    ),
    [
      "1 headings in English, 0 in the variant",
      "2 list items in English, 3 in the variant",
    ],
  );
});
