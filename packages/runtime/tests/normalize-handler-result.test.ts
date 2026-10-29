/**
 * Unit matrix for `normalizeHandlerResult` (docs 02 §4).
 *
 * Pure classification — no store, no commit. Covers all four outcomes,
 * malformed shapes, the JSON boundary, and non-success effect isolation.
 */

import { describe, it, expect } from "vitest";
import { normalizeHandlerResult } from "../src/commit/normalize-handler-result.js";

describe("normalizeHandlerResult", () => {
  it("parses a success envelope and keeps value + effects", () => {
    const { outcome, diagnostics } = normalizeHandlerResult({
      outcome: "success",
      value: { prompt: "ok" },
      effects: {
        jobStatus: [{ jobId: "j", state: "succeeded", sequence: 1 }],
      },
      completion: "done",
    });
    expect(diagnostics).toEqual([]);
    if (outcome.outcome !== "success") throw new Error("expected success");
    expect(outcome.value).toEqual({ prompt: "ok" });
    expect(outcome.completion).toBe("done");
    expect(outcome.effects?.jobStatus).toHaveLength(1);
  });

  it("rejects a success value that is not a JSON wire value", () => {
    const { outcome, diagnostics } = normalizeHandlerResult({
      outcome: "success",
      value: { bad: () => 1 },
    });
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome !== "failed") throw new Error("expected failed");
    expect(outcome.error).toContain("output-schema-invalid");
    expect(diagnostics.map((d) => d.code)).toContain(
      "value-not-json-serialisable",
    );
  });

  it.each([
    ["ui", [{ parts: [null] }], "effects.ui[0].parts[0]"],
    ["interactions", [null], "effects.interactions[0]"],
    ["notifications", [{ title: "ok" }, "text"], "effects.notifications[1]"],
  ])(
    "rejects a success envelope whose %s effect holds a non-object entry",
    (channel, entries, path) => {
      const { outcome } = normalizeHandlerResult({
        outcome: "success",
        value: {},
        effects: { [channel]: entries },
      });
      expect(outcome).toEqual({
        outcome: "failed",
        error: `output-schema-invalid: ${path} is not an object`,
      });
    },
  );

  it.each([
    [],
    [{ table: "stats", field: "hp", value: 1 }],
    [null],
    {},
    null,
    undefined,
  ])(
    "rejects the removed statePatches channel (%j) with plugin data guidance",
    (statePatches) => {
      expect(
        normalizeHandlerResult({
          outcome: "success",
          effects: { statePatches },
        }).outcome,
      ).toEqual({
        outcome: "failed",
        error:
          "output-schema-invalid: effects.statePatches is no longer supported; use plugin data (effects.pluginData) instead",
      });
    },
  );

  it("preserves a failed handler's error while stripping removed writes", () => {
    const { outcome, diagnostics } = normalizeHandlerResult({
      outcome: "failed",
      error: "Original provider failure",
      effects: {
        statePatches: [{ table: "stats", field: "hp", value: 1 }],
        jobStatus: [{ jobId: "j", state: "failed", sequence: 1 }],
      },
    });
    expect(outcome).toEqual({
      outcome: "failed",
      error: "Original provider failure",
      effects: { jobStatus: [{ jobId: "j", state: "failed", sequence: 1 }] },
    });
    expect(diagnostics.map((d) => d.code)).toContain(
      "non-success-domain-effects-stripped",
    );
  });

  it("strips removed writes from a skipped envelope and preserves its reason", () => {
    const { outcome, diagnostics } = normalizeHandlerResult({
      outcome: "skipped",
      skipReason: "already done",
      effects: { statePatches: [] },
    });
    expect(outcome).toEqual({ outcome: "skipped", skipReason: "already done" });
    expect(diagnostics.map((d) => d.code)).toContain(
      "non-success-domain-effects-stripped",
    );
  });

  it("keeps the suspension reason without committing its effects", () => {
    expect(
      normalizeHandlerResult({
        outcome: "suspended",
        reason: "Wait for input",
        effects: { statePatches: [] },
      }).outcome,
    ).toEqual({ outcome: "suspended", reason: "Wait for input" });
  });

  it("parses skipped and strips domain effects to observability", () => {
    const { outcome, diagnostics } = normalizeHandlerResult({
      outcome: "skipped",
      skipReason: "cache hit",
      effects: {
        pluginData: [{ a: 1 }],
        jobStatus: [{ jobId: "j", state: "cancelled", sequence: 2 }],
      },
    });
    if (outcome.outcome !== "skipped") throw new Error("expected skipped");
    expect(outcome.skipReason).toBe("cache hit");
    expect(outcome.effects?.jobStatus).toHaveLength(1);
    // domain write dropped
    expect(
      (outcome.effects as Record<string, unknown> | undefined)?.pluginData,
    ).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toContain(
      "non-success-domain-effects-stripped",
    );
  });

  it("parses failed and keeps observability effects", () => {
    const { outcome } = normalizeHandlerResult({
      outcome: "failed",
      error: "provider down",
      effects: { jobStatus: [{ jobId: "j", state: "failed", sequence: 3 }] },
    });
    if (outcome.outcome !== "failed") throw new Error("expected failed");
    expect(outcome.error).toBe("provider down");
    expect(outcome.effects?.jobStatus).toHaveLength(1);
  });

  it("parses suspended", () => {
    const { outcome } = normalizeHandlerResult({
      outcome: "suspended",
      reason: "await",
    });
    expect(outcome.outcome).toBe("suspended");
  });

  it("fails a malformed envelope (missing/unknown outcome)", () => {
    for (const raw of [{}, { outcome: "nope" }, 42, null]) {
      const { outcome } = normalizeHandlerResult(raw);
      expect(outcome.outcome).toBe("failed");
      if (outcome.outcome !== "failed") throw new Error("expected failed");
      expect(outcome.error).toContain("output-schema-invalid");
    }
  });

  it("keeps domain effects on a success envelope (non-success rule does not apply)", () => {
    const { outcome, diagnostics } = normalizeHandlerResult({
      outcome: "success",
      value: 1,
      effects: { pluginData: [{ a: 1 }] },
    });
    expect(diagnostics).toEqual([]);
    if (outcome.outcome !== "success") throw new Error("expected success");
    expect(
      (outcome.effects as Record<string, unknown> | undefined)?.pluginData,
    ).toEqual([{ a: 1 }]);
  });
});
