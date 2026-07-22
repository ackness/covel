import { describe, it, expect, vi } from "vitest";
import { getPendingProposals, withPendingProposals } from "@covel/tools";
import type { Proposal } from "@covel/shared";
import { projectEnvelopeSuccessToLegacyOutput } from "../src/commit/project-envelope-result.js";

describe("projectEnvelopeSuccessToLegacyOutput", () => {
  it("flattens a plain-object value to the top level", () => {
    const out = projectEnvelopeSuccessToLegacyOutput(
      { outcome: "success", value: { saved: true, id: "x" } },
      {},
    );
    expect(out).toEqual({ saved: true, id: "x" });
  });

  it("keeps a non-object value under a `value` key", () => {
    expect(
      projectEnvelopeSuccessToLegacyOutput(
        { outcome: "success", value: 42 },
        {},
      ),
    ).toEqual({ value: 42 });
    expect(
      projectEnvelopeSuccessToLegacyOutput(
        { outcome: "success", value: ["a", "b"] },
        {},
      ),
    ).toEqual({ value: ["a", "b"] });
  });

  it("hoists effects domain keys to the top level, not obs channels", () => {
    const out = projectEnvelopeSuccessToLegacyOutput(
      {
        outcome: "success",
        value: { stage: "s" },
        effects: {
          events: [{ topic: "t", data: {} }],
          assetGenerations: [{ ref: "r", modality: "image" }],
          jobStatus: [{ jobId: "j", state: "succeeded", sequence: 1 }],
          diagnostics: [{ code: "c", message: "m" }],
        },
      },
      {},
    );
    expect(out.stage).toBe("s");
    expect(out.events).toEqual([{ topic: "t", data: {} }]);
    expect(out.assetGenerations).toEqual([{ ref: "r", modality: "image" }]);
    // Observability channels are NOT read by normalizeOutput — keep them out.
    expect("jobStatus" in out).toBe(false);
    expect("diagnostics" in out).toBe(false);
  });

  it("lets effects win a value key clash and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = projectEnvelopeSuccessToLegacyOutput(
      {
        outcome: "success",
        value: { events: "from-value" },
        effects: { events: [{ topic: "t", data: {} }] },
      },
      {},
    );
    expect(out.events).toEqual([{ topic: "t", data: {} }]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("effects.events overrides value.events"),
    );
    warn.mockRestore();
  });

  it('maps completion:"done" to the legacy preGameDone signal', () => {
    expect(
      projectEnvelopeSuccessToLegacyOutput(
        {
          outcome: "success",
          value: { initialized: true },
          completion: "done",
        },
        {},
      ),
    ).toEqual({ initialized: true, preGameDone: true });

    // completion:"pending" is not the done signal.
    const pending = projectEnvelopeSuccessToLegacyOutput(
      { outcome: "success", value: {}, completion: "pending" },
      {},
    );
    expect("preGameDone" in pending).toBe(false);
  });

  it("carries the raw return's pending-proposals Symbol onto the new object", () => {
    const proposal = { id: "p1", type: "plugin.data" } as unknown as Proposal;
    const raw = withPendingProposals({ x: 1 }, [proposal]);
    const out = projectEnvelopeSuccessToLegacyOutput(
      { outcome: "success", value: { saved: true } },
      raw,
    );
    expect(getPendingProposals(out)).toEqual([proposal]);
    // The projected object is fresh — the value shape, not the raw's.
    expect(out).toMatchObject({ saved: true });
    expect("x" in out).toBe(false);
  });

  it("returns a bare object when the raw carries no pending proposals", () => {
    const out = projectEnvelopeSuccessToLegacyOutput(
      { outcome: "success", value: { a: 1 } },
      {},
    );
    expect(getPendingProposals(out)).toEqual([]);
  });
});
