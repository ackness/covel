import { describe, it, expect } from "vitest";
import { commitProposals } from "../src/commit/commit-service.js";
import type { ValidatedProposalEnvelope } from "@covel/shared";
import type { TurnState } from "../src/types.js";

function emptyTurnState(): TurnState {
  return {
    state: {},
    events: [],
    records: new Map(),
    narrativeSegments: [],
    renderBlocks: [],
  };
}

function makeEnvelope(
  items: Array<{ kind: string; payload: unknown }>,
  meta?: Partial<ValidatedProposalEnvelope>
): ValidatedProposalEnvelope {
  return {
    proposalId: "prop-1",
    runId: "run-1",
    branchId: "branch-1",
    turnId: "turn-1",
    runtimeId: "rt-1",
    pluginId: "p-1",
    traceId: "trace-1",
    validatedAt: new Date().toISOString(),
    items: items as any,
    ...meta,
  };
}

describe("commit-service", () => {
  it("commits narrative.append", () => {
    const state = emptyTurnState();
    const envelope = makeEnvelope([
      { kind: "narrative.append", payload: { text: "Once upon a time..." } },
    ]);

    commitProposals(state, [envelope], { turnId: "t1", branchId: "b1" });

    expect(state.narrativeSegments).toEqual(["Once upon a time..."]);
  });

  it("commits state.patch", () => {
    const state = emptyTurnState();
    state.state = { hp: 100, location: "town" };

    const envelope = makeEnvelope([
      { kind: "state.patch", payload: { hp: 80, gold: 50 } },
    ]);

    commitProposals(state, [envelope], { turnId: "t1", branchId: "b1" });

    expect(state.state).toEqual({ hp: 80, location: "town", gold: 50 });
  });

  it("commits event.emit", () => {
    const state = emptyTurnState();
    const envelope = makeEnvelope([
      { kind: "event.emit", payload: { type: "combat.start" } },
    ]);

    commitProposals(state, [envelope], { turnId: "t1", branchId: "b1" });

    expect(state.events).toHaveLength(1);
    expect(state.events[0].type).toBe("combat.start");
  });

  it("commits record.upsert", () => {
    const state = emptyTurnState();
    const envelope = makeEnvelope([
      { kind: "record.upsert", payload: { key: "npc-1", value: { name: "Bob" } } },
    ]);

    commitProposals(state, [envelope], { turnId: "t1", branchId: "b1" });

    expect(state.records.get("npc-1")).toEqual({ name: "Bob" });
  });

  it("commits ui.render with source tracking", () => {
    const state = emptyTurnState();
    const envelope = makeEnvelope(
      [{ kind: "ui.render", payload: { type: "choices", content: { options: ["a", "b"] } } }],
      { runtimeId: "rt-x", pluginId: "p-x" }
    );

    commitProposals(state, [envelope], { turnId: "t1", branchId: "b1" });

    expect(state.renderBlocks).toHaveLength(1);
    expect(state.renderBlocks[0].source?.pluginId).toBe("p-x");
  });

  it("returns a CommitResult", () => {
    const state = emptyTurnState();
    const result = commitProposals(state, [], { turnId: "t1", branchId: "b1" });

    expect(result.turnId).toBe("t1");
    expect(result.branchId).toBe("b1");
    expect(result.commitId).toBeTruthy();
    expect(result.committedAt).toBeTruthy();
  });
});
