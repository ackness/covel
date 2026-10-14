import { describe, expect, it } from "vitest";
import type { InputSlot } from "@covel/shared";
import { freezeInputSlots } from "../src/agent-loop/runtime-input-slots.js";

describe("declared tool input slots", () => {
  it("freezes a copy so hooks and tools cannot change upstream output", () => {
    const value = { attributes: [] as string[] };
    const inputs: Record<string, InputSlot> = {
      schema: {
        cardinality: "one",
        value,
        source: {
          pluginId: "producer",
          runtimeId: "producer",
          resultId: "result-1",
        },
      },
    };
    const slots = freezeInputSlots(inputs);
    expect(Object.isFrozen(slots)).toBe(true);
    expect(Object.isFrozen(slots["schema"])).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
    expect(slots).toEqual(inputs);
  });
});
