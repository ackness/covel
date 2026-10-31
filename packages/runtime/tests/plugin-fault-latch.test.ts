import { describe, expect, it } from "vitest";
import type { RuntimeResult } from "@covel/shared";
import { createPluginFaultLatch } from "../src/faults/plugin-fault-latch.js";

function result(extra: Partial<RuntimeResult> = {}): RuntimeResult {
  return {
    pluginId: "p",
    runtimeId: "p/run",
    runId: "run",
    turnId: "turn",
    status: "failed",
    fault: "runtime",
    output: null,
    toolCalls: [],
    durationMs: 0,
    timestamp: "2026-10-29T00:00:00Z",
    ...extra,
  };
}
const outcome = {
  status: "committed" as const,
  events: [],
  failedProposals: [],
  operations: [],
};
const record = (
  latch: ReturnType<typeof createPluginFaultLatch>,
  logicalKey: string,
  results = [result()],
  exempt: ReadonlySet<string> = new Set(),
) =>
  latch.recordExecution({
    sessionId: "s",
    logicalKey,
    results,
    outcome,
    exempt,
  });

describe("plugin fault latch", () => {
  it("latches at three logical inputs, deduping runtimes, hooks and advance rounds", () => {
    const latch = createPluginFaultLatch();
    expect(
      record(latch, "one", [result(), result({ runId: "second" })]),
    ).toHaveLength(1);
    expect(latch.recordHookFault("s", "p", "one", "hook")).toEqual([]);
    expect(record(latch, "one")).toEqual([]);
    record(latch, "two");
    expect(record(latch, "three").map((event) => event.type)).toEqual([
      "plugin.fault.counted",
      "plugin.fault.latched",
    ]);
    expect(latch.latched("s")).toEqual([
      { pluginId: "p", consecutiveFaults: 3, latched: true, reason: "runtime" },
    ]);
    expect(latch.isLatched("other", "p")).toBe(false);
  });
  it("resets only after a committed clean run on another input", () => {
    const latch = createPluginFaultLatch();
    record(latch, "one");
    expect(record(latch, "one", [result({ status: "success" })])).toEqual([]);
    expect(record(latch, "clean", [result({ status: "success" })])).toEqual([
      {
        type: "plugin.fault.cleared",
        payload: { sessionId: "s", pluginId: "p", by: "clean-run" },
      },
    ]);
    record(latch, "two");
    record(latch, "three");
    expect(latch.isLatched("s", "p")).toBe(false);
  });
  it("leaves neutral and rolled-back clean runs unchanged", () => {
    const latch = createPluginFaultLatch();
    record(latch, "one");
    record(latch, "neutral", [result({ status: "skipped", fault: undefined })]);
    latch.recordExecution({
      sessionId: "s",
      logicalKey: "rollback",
      results: [result({ status: "success" })],
      outcome: { ...outcome, status: "failed" },
      exempt: new Set(),
    });
    record(latch, "two");
    record(latch, "three");
    expect(latch.isLatched("s", "p")).toBe(true);
  });
  it("traces exempt faults without latching", () => {
    const latch = createPluginFaultLatch();
    for (const key of ["one", "two", "three", "four"])
      expect(
        record(latch, key, [result()], new Set(["p"])).map(
          (event) => event.type,
        ),
      ).toEqual(["plugin.fault.counted"]);
    expect(
      latch.recordHookFault("s", "story", "one", "hook", true)[0]?.type,
    ).toBe("plugin.fault.counted");
    expect(latch.latched("s")).toEqual([]);
  });
  it("player re-enable resets the count and dedupe; clean cannot unpause it", () => {
    const latch = createPluginFaultLatch({ threshold: 1 });
    record(latch, "one");
    expect(record(latch, "clean", [result({ status: "success" })])).toEqual([]);
    expect(latch.clear("s", "p", "player")).toEqual([
      {
        type: "plugin.fault.cleared",
        payload: { sessionId: "s", pluginId: "p", by: "player" },
      },
    ]);
    expect(latch.isLatched("s", "p")).toBe(false);
    expect(record(latch, "one")[0]?.payload).toMatchObject({
      consecutiveFaults: 1,
    });
  });
  it("does not hide a failing handler behind an earlier clean hook in the same input", () => {
    const latch = createPluginFaultLatch();
    for (const key of ["one", "two", "three"]) {
      latch.recordHookClean("s", "p", key);
      latch.recordHookFault("s", "p", key, "hook");
    }
    expect(latch.isLatched("s", "p")).toBe(true);
  });
  it("resets hooks-only plugins and isolates sessions; restart and forget are empty", () => {
    const latch = createPluginFaultLatch({ threshold: 2 });
    latch.recordHookFault("s", "p", "one", "hook");
    latch.recordHookClean("s", "p", "clean");
    latch.recordHookFault("s", "p", "two", "timeout");
    expect(latch.isLatched("s", "p")).toBe(false);
    latch.recordHookFault("s", "p", "three", "hook");
    latch.recordHookFault("other", "p", "one", "hook");
    expect(latch.isLatched("s", "p")).toBe(true);
    expect(latch.isLatched("other", "p")).toBe(false);
    expect(createPluginFaultLatch().latched("s")).toEqual([]);
    latch.forgetSession("s");
    expect(latch.latched("s")).toEqual([]);
  });
});
