import { describe, it, expect } from "vitest";
import { createProposalCollector } from "../src/proposals/proposal-collector.js";
import { validateProposals } from "../src/proposals/proposal-validator.js";

const turnContext = {
  runId: "run-1",
  branchId: "branch-1",
  turnId: "turn-1",
  traceId: "trace-1",
};

describe("proposal-collector", () => {
  it("collects proposals from multiple runtimes", () => {
    const collector = createProposalCollector(turnContext);

    collector.addFromRuntime("rt1", "plugin-a", [
      { kind: "narrative.append", payload: { text: "Hello" } },
    ]);
    collector.addFromRuntime("rt2", "plugin-b", [
      { kind: "state.patch", payload: { score: 10 } },
    ]);

    const all = collector.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].runtimeId).toBe("rt1");
    expect(all[1].runtimeId).toBe("rt2");
  });

  it("skips empty proposal lists", () => {
    const collector = createProposalCollector(turnContext);
    collector.addFromRuntime("rt1", "plugin-a", []);
    expect(collector.getAll()).toHaveLength(0);
  });

  it("includes trace metadata", () => {
    const collector = createProposalCollector(turnContext);
    collector.addFromRuntime("rt1", "p1", [
      { kind: "event.emit", payload: { type: "combat.start" } },
    ]);

    const envelope = collector.getAll()[0];
    expect(envelope.runId).toBe("run-1");
    expect(envelope.branchId).toBe("branch-1");
    expect(envelope.turnId).toBe("turn-1");
    expect(envelope.traceId).toBe("trace-1");
  });
});

describe("proposal-validator", () => {
  it("validates correct proposals", () => {
    const collector = createProposalCollector(turnContext);
    collector.addFromRuntime("rt1", "p1", [
      { kind: "narrative.append", payload: { text: "Story text" } },
      { kind: "state.patch", payload: { hp: 90 } },
    ]);

    const { valid, rejected } = validateProposals(collector.getAll());
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(0);
    expect(valid[0].validatedAt).toBeTruthy();
  });

  it("skips proposals with invalid kinds at collection time", () => {
    const collector = createProposalCollector(turnContext);
    collector.addFromRuntime("rt1", "p1", [
      { kind: "invalid.kind", payload: {} },
    ]);

    // Invalid kinds are filtered out by the collector, so no envelopes are created
    expect(collector.getAll()).toHaveLength(0);
  });

  it("rejects proposals with null payload", () => {
    const collector = createProposalCollector(turnContext);
    collector.addFromRuntime("rt1", "p1", [
      { kind: "narrative.append", payload: null as any },
    ]);

    const { valid, rejected } = validateProposals(collector.getAll());
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("Missing payload");
  });

  it("detects state.patch key conflicts", () => {
    const collector = createProposalCollector(turnContext);
    collector.addFromRuntime("rt1", "p1", [
      { kind: "state.patch", payload: { hp: 90 } },
    ]);
    collector.addFromRuntime("rt2", "p2", [
      { kind: "state.patch", payload: { hp: 80 } },
    ]);

    const { valid, rejected } = validateProposals(collector.getAll());
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("conflict");
  });
});
