import { describe, expect, it } from "vitest";
import { ToolError, tool } from "@covel/plugin-handlers-utils";
import makeAdvanceTime from "../tools/advance-world-time.js";
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

describe("world time tool errors", () => {
  const instance = makeAdvanceTime({ tool });
  const request = { amount: 1, unit: "minute", reason: "A minute passes." };
  const ctx = {
    turnId: "current-turn",
    inputSlots,
    store: { getPluginData: async () => null },
  };
  it("reports missing host inputs as unavailable", async () => {
    await expect(
      instance.execute(request, { ...ctx, inputSlots: {} }),
    ).rejects.toMatchObject({
      name: "ToolError",
      code: "unavailable",
      message:
        "World time requires currentTime and a successful same-turn narrative input",
    });
  });
  it("reports a stale clock as conflict with a next-turn hint", async () => {
    await expect(
      instance.execute(request, {
        ...ctx,
        store: {
          getPluginData: async () => ({
            value: { tick: inputSlots.currentTime.value.tick + 1 },
          }),
        },
      }),
    ).rejects.toMatchObject({
      name: "ToolError",
      code: "conflict",
      message: "World time changed since this narrative started",
      hint: "Stop; the next turn reads the current clock.",
    });
  });
  it("keeps a corrupt stored tick as an internal fault", async () => {
    const error = await instance
      .execute(request, {
        ...ctx,
        inputSlots: {
          ...inputSlots,
          currentTime: {
            ...inputSlots.currentTime,
            value: { ...inputSlots.currentTime.value, tick: NaN },
          },
        },
      })
      .catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ToolError);
    expect(error.message).toBe("Invalid current time tick");
  });
});
