/**
 * Unit matrix for `normalizeHandlerResult` (docs 02 §4).
 *
 * Pure classification — no store, no commit. Covers the legacy adapter (whole
 * object preserved as value, control keys copied to effects, business status
 * mapping), the envelope-v1 discriminated union (four branches, malformed shape,
 * JSON value boundary), and the non-success domain-effect stripping rule.
 */

import { describe, it, expect } from "vitest";
import { getPendingProposals, withPendingProposals } from "@covel/tools";
import type { Proposal } from "@covel/shared";
import { normalizeHandlerResult } from "../src/commit/normalize-handler-result.js";

const LEGACY = { resultFormat: "legacy", runtimeType: "function" } as const;
const ENVELOPE = {
  resultFormat: "envelope-v1",
  runtimeType: "function",
} as const;

describe("normalizeHandlerResult — legacy", () => {
  it("preserves the whole object as value and copies control keys to effects", () => {
    const raw = {
      narrativeOutput: "hello",
      ref: { id: "a".repeat(64), mime: "image/png", size: 10 },
      statePatches: [{ table: "t", field: "f", value: 1 }],
      pluginData: [{ namespace: "n", key: "k", value: 2 }],
      events: [{ topic: "x", data: {} }],
    };
    const { outcome, diagnostics } = normalizeHandlerResult(raw, LEGACY);
    expect(diagnostics).toEqual([]);
    if (outcome.outcome !== "success") throw new Error("expected success");
    // value is the whole object, byte-identical (same reference) so downstream
    // binding reads (e.g. `ref`) and the commit-path normalizer see every field.
    expect(outcome.value).toBe(raw);
    expect(outcome.effects?.statePatches).toEqual(raw.statePatches);
    expect(outcome.effects?.pluginData).toEqual(raw.pluginData);
    expect(outcome.effects?.events).toEqual(raw.events);
  });

  it("maps business status: failed → failed outcome", () => {
    const { outcome } = normalizeHandlerResult(
      { status: "failed", error: "boom" },
      LEGACY,
    );
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome !== "failed") throw new Error("expected failed");
    expect(outcome.error).toBe("boom");
  });

  it("maps business status: skipped → skipped outcome", () => {
    const { outcome } = normalizeHandlerResult(
      { status: "skipped", reason: "nothing to do" },
      LEGACY,
    );
    expect(outcome.outcome).toBe("skipped");
    if (outcome.outcome !== "skipped") throw new Error("expected skipped");
    expect(outcome.skipReason).toBe("nothing to do");
  });

  it("maps business status: suspended → suspended outcome with resumeSchema", () => {
    const schema = { type: "object" };
    const { outcome } = normalizeHandlerResult(
      { status: "suspended", reason: "await input", resumeSchema: schema },
      LEGACY,
    );
    expect(outcome.outcome).toBe("suspended");
    if (outcome.outcome !== "suspended") throw new Error("expected suspended");
    expect(outcome.reason).toBe("await input");
    expect(outcome.resumeSchema).toEqual(schema);
  });

  it("treats status: done and ambiguous statuses as success", () => {
    for (const status of ["done", "weird", undefined]) {
      const { outcome } = normalizeHandlerResult({ status, x: 1 }, LEGACY);
      expect(outcome.outcome).toBe("success");
    }
  });

  it("preserves a non-object return verbatim as a success value", () => {
    const { outcome } = normalizeHandlerResult("just text", LEGACY);
    expect(outcome).toMatchObject({ outcome: "success", value: "just text" });
  });

  it("keeps the Symbol pending-proposals channel on the preserved value", () => {
    const proposal = { id: "p1", type: "state.patch" } as unknown as Proposal;
    const raw = withPendingProposals({ narrativeOutput: "hi" }, [proposal]);
    const { outcome } = normalizeHandlerResult(raw, LEGACY);
    if (outcome.outcome !== "success") throw new Error("expected success");
    // value is the same reference, so the non-enumerable Symbol channel the
    // commit path reads survives.
    expect(getPendingProposals(outcome.value)).toEqual([proposal]);
  });

  it("strips domain effects from a legacy non-success return and diagnoses it", () => {
    const { outcome, diagnostics } = normalizeHandlerResult(
      { status: "skipped", reason: "x", statePatches: [{ a: 1 }] },
      LEGACY,
    );
    expect(outcome.outcome).toBe("skipped");
    // statePatches is a domain effect — not allowed on a non-success outcome.
    if (outcome.outcome !== "skipped") throw new Error("expected skipped");
    expect(outcome.effects).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toContain(
      "non-success-domain-effects-stripped",
    );
  });
});

describe("normalizeHandlerResult — envelope-v1", () => {
  it("parses a success envelope and keeps value + effects", () => {
    const { outcome, diagnostics } = normalizeHandlerResult(
      {
        outcome: "success",
        value: { prompt: "ok" },
        effects: {
          jobStatus: [{ jobId: "j", state: "succeeded", sequence: 1 }],
        },
        completion: "done",
      },
      ENVELOPE,
    );
    expect(diagnostics).toEqual([]);
    if (outcome.outcome !== "success") throw new Error("expected success");
    expect(outcome.value).toEqual({ prompt: "ok" });
    expect(outcome.completion).toBe("done");
    expect(outcome.effects?.jobStatus).toHaveLength(1);
  });

  it("rejects a success value that is not a JSON wire value", () => {
    const { outcome, diagnostics } = normalizeHandlerResult(
      { outcome: "success", value: { bad: () => 1 } },
      ENVELOPE,
    );
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome !== "failed") throw new Error("expected failed");
    expect(outcome.error).toContain("output-schema-invalid");
    expect(diagnostics.map((d) => d.code)).toContain(
      "value-not-json-serialisable",
    );
  });

  it("parses skipped and strips domain effects to observability", () => {
    const { outcome, diagnostics } = normalizeHandlerResult(
      {
        outcome: "skipped",
        skipReason: "cache hit",
        effects: {
          statePatches: [{ a: 1 }],
          jobStatus: [{ jobId: "j", state: "cancelled", sequence: 2 }],
        },
      },
      ENVELOPE,
    );
    if (outcome.outcome !== "skipped") throw new Error("expected skipped");
    expect(outcome.skipReason).toBe("cache hit");
    expect(outcome.effects?.jobStatus).toHaveLength(1);
    // domain write dropped
    expect(
      (outcome.effects as Record<string, unknown> | undefined)?.statePatches,
    ).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toContain(
      "non-success-domain-effects-stripped",
    );
  });

  it("parses failed and keeps observability effects", () => {
    const { outcome } = normalizeHandlerResult(
      {
        outcome: "failed",
        error: "provider down",
        effects: { jobStatus: [{ jobId: "j", state: "failed", sequence: 3 }] },
      },
      ENVELOPE,
    );
    if (outcome.outcome !== "failed") throw new Error("expected failed");
    expect(outcome.error).toBe("provider down");
    expect(outcome.effects?.jobStatus).toHaveLength(1);
  });

  it("parses suspended", () => {
    const { outcome } = normalizeHandlerResult(
      { outcome: "suspended", reason: "await" },
      ENVELOPE,
    );
    expect(outcome.outcome).toBe("suspended");
  });

  it("fails a malformed envelope (missing/unknown outcome)", () => {
    for (const raw of [{}, { outcome: "nope" }, 42, null]) {
      const { outcome } = normalizeHandlerResult(raw, ENVELOPE);
      expect(outcome.outcome).toBe("failed");
      if (outcome.outcome !== "failed") throw new Error("expected failed");
      expect(outcome.error).toContain("output-schema-invalid");
    }
  });

  it("keeps domain effects on a success envelope (non-success rule does not apply)", () => {
    const { outcome, diagnostics } = normalizeHandlerResult(
      { outcome: "success", value: 1, effects: { statePatches: [{ a: 1 }] } },
      ENVELOPE,
    );
    expect(diagnostics).toEqual([]);
    if (outcome.outcome !== "success") throw new Error("expected success");
    expect(
      (outcome.effects as Record<string, unknown> | undefined)?.statePatches,
    ).toEqual([{ a: 1 }]);
  });
});
