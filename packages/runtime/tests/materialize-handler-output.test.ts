import { describe, it, expect } from "vitest";
import { withPendingProposals } from "@covel/tools";
import type { Proposal } from "@covel/shared";
import { materializeHandlerSuccess } from "../src/commit/materialize-handler-output.js";

describe("materializeHandlerSuccess", () => {
  it("keeps identically named business data and effects independent", () => {
    const value = {
      events: [{ topic: "business.only", data: { count: 1 } }],
      pluginData: [{ namespace: "facts", key: "business", value: true }],
      preGameDone: true,
    };
    const effects = { events: [{ topic: "published", data: {} }] };
    const result = materializeHandlerSuccess(
      { outcome: "success", value, effects, completion: "pending" },
      {},
    );
    expect(result.output).toEqual(value);
    expect(result.effects).toEqual(effects);
    expect(result.completion).toBe("pending");
    value.events[0]!.data.count = 2;
    effects.events[0]!.topic = "changed";
    expect(result.output?.events).toEqual([
      { topic: "business.only", data: { count: 1 } },
    ]);
    expect(result.effects?.events).toEqual([{ topic: "published", data: {} }]);
  });

  it.each([42, ["a", "b"], null])(
    "projects non-object business value %j",
    (value) => {
      expect(
        materializeHandlerSuccess({ outcome: "success", value }, {}),
      ).toEqual({
        output: { value },
      });
    },
  );

  it("does not add completion or effect fields to the business value", () => {
    const result = materializeHandlerSuccess(
      {
        outcome: "success",
        value: { initialized: true },
        completion: "done",
        effects: { notifications: [{ message: "Ready" }] },
      },
      {},
    );
    expect(result).toEqual({
      output: { initialized: true },
      completion: "done",
      effects: { notifications: [{ message: "Ready" }] },
    });
  });

  it("retains proposal-backed commands without serializing them as business data", () => {
    const proposal = { id: "p1", type: "plugin.data" } as unknown as Proposal;
    const raw = withPendingProposals({}, [proposal]);
    const result = materializeHandlerSuccess(
      { outcome: "success", value: { saved: true } },
      raw,
    );
    expect(result.pendingProposals).toEqual([proposal]);
    expect(JSON.stringify(result.output)).toBe('{"saved":true}');
  });

  it("preserves special JSON keys as data without changing the output prototype", () => {
    const value = JSON.parse('{"__proto__":{"polluted":true}}');
    const result = materializeHandlerSuccess({ outcome: "success", value }, {});
    expect(Object.hasOwn(result.output!, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.output)).toBe(Object.prototype);
  });
});
