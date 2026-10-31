import { describe, expect, it } from "vitest";
import trackerReadBudget from "../hooks/tracker-read-budget.js";

const ctx = { runtimeId: "char-creator/character-tracker", locale: "en-US" };
const tools = [
  { name: "get-character", parameters: {} },
  {
    name: "sync-characters",
    parameters: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            properties: {
              id: { type: "string" },
              name: {},
              type: {},
              description: {},
              fields: { type: "object" },
              aliases: {},
              removeAliases: {},
            },
          },
        },
      },
    },
  },
];
const assistant = {
  role: "assistant",
  content: "",
  toolCalls: [{ id: "read", name: "get-character", arguments: "{}" }],
};
const payload = (result) => ({
  tools,
  messages: [
    assistant,
    { role: "tool", toolCallId: "read", content: JSON.stringify(result) },
  ],
});

describe("tracker detail read budget", () => {
  it("withholds detail reads and appends the completion hint after a successful result", () => {
    const result = trackerReadBudget(
      ctx,
      payload({ summary: "Character detail" }),
    );
    expect(result.replace.tools.map((tool) => tool.name)).toEqual([
      "sync-characters",
    ]);
    expect(result.replace.messages.at(-1).content).toContain(
      "Call sync-characters",
    );
  });
  it("keeps the read available after an error or before a matching result arrives", () => {
    for (const messages of [
      payload({ error: { code: "not-found", message: "Unknown character" } })
        .messages,
      [assistant],
      [{ role: "tool", toolCallId: "other", content: "{}" }],
    ]) {
      const result = trackerReadBudget(ctx, { tools, messages });
      expect(result.replace.tools.map((tool) => tool.name)).toContain(
        "get-character",
      );
      expect(result.replace.messages).toBeUndefined();
    }
  });
  it("retains the update schema rewrite without mutating the offered tools", () => {
    const original = structuredClone(tools);
    const result = trackerReadBudget(ctx, { tools, messages: [] });
    expect(
      Object.keys(
        result.replace.tools[1].parameters.properties.updates.items.properties,
      ),
    ).toEqual(["id", "fields", "aliases", "removeAliases"]);
    expect(tools).toEqual(original);
  });
  it("leaves other runtimes alone", () => {
    expect(
      trackerReadBudget(
        { ...ctx, runtimeId: "other/agent" },
        payload({ summary: "Read" }),
      ),
    ).toEqual({ action: "continue" });
  });
});
