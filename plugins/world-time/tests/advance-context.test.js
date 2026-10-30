import { describe, expect, it } from "vitest";
import advanceContext from "../server/advance-context.js";
import { DEFAULT_TIME, initialTick } from "../clock.js";

const definition = structuredClone(DEFAULT_TIME);
definition.initial = { year: 1, month: 4, day: 8, hour: 12, minute: 30 };
const inputSlots = {
  currentTime: {
    cardinality: "one",
    source: { resultId: "private-row" },
    value: {
      definition,
      tick: initialTick(definition),
      locale: "en",
      hour: 16,
      minute: 0,
      reason: "The previous story stopped at 16:00.",
      lastTurnId: "old-execution",
      lastDelta: 0,
    },
  },
  narrative: {
    cardinality: "one",
    value: "The wall clock reads 16:20. Mira waits for your reply.",
  },
};
describe("time settlement exact context", () => {
  it("uses typed current story and authoritative tick, excluding old explanations and player plans", () => {
    const payload = {
      inputSlots,
      promptTemplate: "Settle currentTime against narrative.value.",
      systemPrompt: "narrative.value: (see the conversation below)",
      messages: [
        { role: "user", content: "Tomorrow I plan to leave at 18:00." },
        { role: "assistant", content: inputSlots.narrative.value },
      ],
    };
    const result = advanceContext({ runtimeId: "world-time/advance" }, payload);
    expect(result.replace.systemPrompt).toBe(payload.promptTemplate);
    expect(result.replace.messages).toHaveLength(1);
    const data = JSON.parse(result.replace.messages[0].content);
    expect(data.narrative.value).toBe(inputSlots.narrative.value);
    expect(data.currentTime.value).toMatchObject({
      hour: 12,
      minute: 30,
      units: ["minute", "hour", "day"],
    });
    for (const field of ["reason", "lastTurnId", "lastDelta", "source"])
      expect(result.replace.messages[0].content).not.toContain(field);
    expect(result.replace.messages[0].content).not.toContain("18:00");
    expect(inputSlots.currentTime.value.hour).toBe(16);
  });
  it("leaves other runtimes and absent bindings alone", () => {
    expect(
      advanceContext({ runtimeId: "other/advance" }, { inputSlots }),
    ).toEqual({ action: "continue" });
    expect(
      advanceContext({ runtimeId: "world-time/advance" }, { inputSlots: {} }),
    ).toEqual({ action: "continue" });
  });
});
