import { describe, expect, it } from "vitest";
import type { OperationRecord, Proposal } from "@covel/shared";
import {
  asOperationFailures,
  OperationLedger,
  operationFailureReason,
  settlementsOf,
} from "../src/commit/operation-ledger.js";
import type { FinalizableResult } from "../src/commit/finalize-types.js";
import type { FailedProposal } from "../src/session/session-runtime-result.js";

function write(id: string, type: Proposal["type"] = "plugin.data"): Proposal {
  return {
    id,
    type,
    sessionId: "session",
    turnId: "turn",
    source: { pluginId: "provider", runtimeId: "service:change" },
    payload: { namespace: "values", key: id, value: 1 },
    timestamp: "2026-11-09T00:00:00.000Z",
  } as Proposal;
}

function record(
  id: string,
  seq: number,
  overrides: Partial<OperationRecord> = {},
): OperationRecord {
  return {
    id,
    contract: `${id}@1`,
    providerPluginId: "provider",
    service: id,
    invokedBy: { pluginId: "probe", runtimeId: "probe/caller" },
    seq,
    status: "staged",
    summary: id,
    ...overrides,
  };
}

function caller(
  runtimeId: string,
  operations: readonly OperationRecord[],
  overrides: Partial<FinalizableResult> = {},
): FinalizableResult {
  return {
    pluginId: "probe",
    runtimeId,
    turnId: "turn",
    runId: `run-${runtimeId}`,
    status: "success",
    output: {},
    operations,
    operationWrites: Object.fromEntries(
      operations.map((op) => [op.id, [write(`${op.id}-write`)]]),
    ),
    ...overrides,
  };
}

describe("OperationLedger", () => {
  it("stages only operations that can still commit", () => {
    const committable = caller("ok", [record("ok", 1)]);
    const failedCaller = caller("failed", [record("failed-caller", 2)], {
      status: "failed",
    });
    const unstaged = caller("unstaged", [
      record("unstaged", 3, { status: "failed", reason: "rejected" }),
    ]);
    const empty = caller("empty", [record("empty", 4)], {
      operationWrites: {},
    });
    const malformed = caller("malformed", [record("malformed", 5)], {
      effects: { statePatches: [] } as never,
    });
    const ledger = new OperationLedger(
      [committable, failedCaller, unstaged, empty, malformed],
      undefined,
    );

    expect(ledger.entries.map((entry) => entry.record.id)).toEqual([
      "ok",
      "failed-caller",
      "unstaged",
      "empty",
      "malformed",
    ]);
    expect(ledger.entry("ok")?.member).toBe(committable);
    expect(ledger.entry("ok")?.writes.map((w) => w.id)).toEqual(["ok-write"]);
    expect(ledger.entry("missing")).toBeUndefined();
    expect(
      ledger.entries.map((entry) => [
        entry.record.id,
        ledger.statusOf(entry),
        ledger.dropped(entry),
      ]),
    ).toEqual([
      ["ok", "staged", false],
      ["failed-caller", "discarded", true],
      ["unstaged", "discarded", true],
      ["empty", "discarded", true],
      ["malformed", "discarded", true],
    ]);
    // A discarded operation keeps the reason it was recorded with.
    expect(
      ledger
        .finalized()
        .map(({ id, status, reason }) => ({ id, status, reason })),
    ).toEqual([
      { id: "ok", status: "staged", reason: undefined },
      { id: "failed-caller", status: "discarded", reason: "caller-dropped" },
      { id: "unstaged", status: "discarded", reason: "rejected" },
      { id: "empty", status: "discarded", reason: "caller-dropped" },
      { id: "malformed", status: "discarded", reason: "caller-dropped" },
    ]);
  });

  it("stages the buffered writes of a skipped run", () => {
    const skipped = caller("skipped", [record("op", 1)], {
      status: "skipped",
      output: null,
      pendingProposals: [write("buffered")],
    });
    const ledger = new OperationLedger([skipped], undefined);
    expect(ledger.statusOf(ledger.entry("op")!)).toBe("staged");
  });

  it("lists the staged operations of a unit's members in call order", () => {
    const child = caller("child", [record("c2", 4), record("c1", 1)]);
    const parent = caller("parent", [record("p", 2)]);
    const other = caller("other", [record("o", 3)]);
    const ledger = new OperationLedger([child, parent, other], undefined);

    expect(
      ledger.stagedOf([child, parent]).map((entry) => entry.record.id),
    ).toEqual(["c1", "p", "c2"]);
    ledger.settle(ledger.entry("p")!, "committed");
    ledger.settle(ledger.entry("c1")!, "failed", "conflict");
    expect(
      ledger.stagedOf([child, parent]).map((entry) => entry.record.id),
    ).toEqual(["c2"]);
    expect(ledger.dropped(ledger.entry("p")!)).toBe(false);
    expect(ledger.dropped(ledger.entry("c1")!)).toBe(true);
  });

  it("finalizes every operation in call order, abandoned records included", () => {
    const run = caller("run", [record("b", 3), record("a", 1)]);
    const ledger = new OperationLedger(
      [run],
      [record("a", 1), record("abandoned", 2), record("b", 3)],
    );
    ledger.settle(ledger.entry("a")!, "committed");
    ledger.settle(ledger.entry("b")!, "failed", "rejected");

    expect(ledger.finalized()).toEqual([
      {
        id: "a",
        status: "committed",
        contract: "a@1",
        invokedBy: { pluginId: "probe", runtimeId: "probe/caller" },
      },
      {
        id: "abandoned",
        status: "discarded",
        reason: "caller-dropped",
        contract: "abandoned@1",
        invokedBy: { pluginId: "probe", runtimeId: "probe/caller" },
      },
      {
        id: "b",
        status: "failed",
        reason: "rejected",
        contract: "b@1",
        invokedBy: { pluginId: "probe", runtimeId: "probe/caller" },
      },
    ]);
    // A rolled-back execution ends every operation the same way.
    expect(
      ledger
        .finalized({ status: "failed", reason: "execution-failed" })
        .map(({ id, status, reason }) => [id, status, reason]),
    ).toEqual([
      ["a", "failed", "execution-failed"],
      ["abandoned", "failed", "execution-failed"],
      ["b", "failed", "execution-failed"],
    ]);
  });
});

describe("operation settlement helpers", () => {
  it("keeps only the id, status and reason for the turn_results rows", () => {
    expect(
      settlementsOf([
        {
          id: "a",
          status: "committed",
          contract: "a@1",
          invokedBy: { pluginId: "probe", runtimeId: "probe/caller" },
        },
        {
          id: "b",
          status: "failed",
          reason: "conflict",
          contract: "b@1",
          invokedBy: { pluginId: "probe", runtimeId: "probe/caller" },
        },
      ]),
    ).toEqual([
      { id: "a", status: "committed" },
      { id: "b", status: "failed", reason: "conflict" },
    ]);
  });

  const failure = (
    code: string | undefined,
    type: Proposal["type"] = "plugin.data",
  ): FailedProposal => ({
    proposal: write("w", type),
    error: "refused",
    ...(code !== undefined ? { code } : {}),
  });

  it("calls a refused operation a conflict only when one write conflicted", () => {
    expect(
      operationFailureReason([failure(undefined), failure("conflict")]),
    ).toBe("conflict");
    expect(operationFailureReason([failure("data-op-rejected")])).toBe(
      "rejected",
    );
    expect(operationFailureReason([])).toBe("rejected");
  });

  it("reads a refused update as a conflict, other refusals as they are", () => {
    const update = failure("data-op-rejected", "plugin.data.update");
    const plain = failure("data-op-rejected");
    const other = failure("hook-veto", "plugin.data.update");
    expect(asOperationFailures([update, plain, other])).toEqual([
      { ...update, code: "conflict" },
      plain,
      other,
    ]);
  });
});
