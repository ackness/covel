import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tool, type PluginToolDefinition } from "../src/index.js";

const parameters = z.object({ value: z.string() });
function define(
  overrides: Partial<PluginToolDefinition<typeof parameters, string>> = {},
) {
  return tool({
    name: "probe",
    description: "Echo a value.",
    parameters,
    execute: async ({ value }) => value,
    ...overrides,
  });
}

describe("tool annotations and timeout", () => {
  it("defaults to a write tool without concurrency safety or a timeout", () => {
    const module = define();
    expect(module.annotations).toEqual({
      readOnly: false,
      stagesWrites: true,
      idempotent: false,
      concurrencySafe: false,
    });
    expect(module).not.toHaveProperty("timeoutMs");
  });

  it("resolves read-only defaults and preserves explicit annotations", () => {
    expect(define({ annotations: { readOnly: true } }).annotations).toEqual({
      readOnly: true,
      stagesWrites: false,
      idempotent: false,
      concurrencySafe: false,
    });
    const annotations = {
      readOnly: true,
      stagesWrites: false,
      idempotent: true,
      concurrencySafe: true,
    };
    const module = define({ annotations });
    annotations.readOnly = false;
    expect(module.annotations).toEqual({ ...annotations, readOnly: true });
    expect(Object.isFrozen(module.annotations)).toBe(true);
    expect(
      define({ annotations: { stagesWrites: false } }).annotations.stagesWrites,
    ).toBe(false);
  });

  it.each([
    [
      { readOnly: true, stagesWrites: true },
      "readOnly cannot be combined with stagesWrites",
    ],
    [{ concurrencySafe: true }, "concurrencySafe requires readOnly"],
    [
      { readOnly: false, concurrencySafe: true },
      "concurrencySafe requires readOnly",
    ],
  ])("rejects illegal annotations: %j", (annotations, reason) => {
    expect(() => define({ annotations })).toThrow(`Tool "probe": ${reason}`);
  });

  it.each([0, -1, 1.5, 600_001, NaN, Infinity])(
    "rejects timeoutMs %s",
    (timeoutMs) => {
      expect(() => define({ timeoutMs })).toThrow(
        'Tool "probe": timeoutMs must be an integer in [1, 600000]',
      );
    },
  );

  it.each([1, 20, 600_000])(
    "accepts timeoutMs %s without changing JSON Schema",
    (timeoutMs) => {
      const module = define({ timeoutMs, annotations: { readOnly: true } });
      expect(module.timeoutMs).toBe(timeoutMs);
      expect(module.jsonSchema).toEqual(define().jsonSchema);
    },
  );
});
