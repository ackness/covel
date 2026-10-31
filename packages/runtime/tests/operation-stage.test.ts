import { describe, expect, it, vi } from "vitest";
import type { Proposal, RuntimeResult } from "@covel/shared";
import {
  createOperationExecutionScope,
  createRootOperationStage,
  hasOperationWrites,
} from "../src/operations/operation-stage.js";
import {
  buildOperationRecord,
  OPERATION_PAYLOAD_MAX_BYTES,
  OPERATION_SUMMARY_MAX_CHARS,
  operationRecordsOf,
} from "../src/operations/operation-records.js";

const write = (key: string, value: unknown): Proposal =>
  ({
    id: `proposal-${key}`,
    sessionId: "session",
    turnId: "turn",
    type: "plugin.data",
    payload: { namespace: "balances", key, value },
    source: { pluginId: "bank", runtimeId: "service:change" },
    createdAt: "2026-10-30T00:00:00.000Z",
  }) as unknown as Proposal;

function root(scope = createOperationExecutionScope()) {
  return createRootOperationStage({
    caller: { pluginId: "shop", runtimeId: "shop/trade" },
    sessionId: "session",
    turnId: "turn",
    scope,
  });
}

const staged = (key: string, value: unknown, provider = "bank") => ({
  contract: "bank.change@1",
  providerPluginId: provider,
  service: "change",
  writes: [write(key, value)],
  request: { key },
  result: { ok: true },
});

describe("operation stage", () => {
  it("numbers operations across every root of one execution", () => {
    const scope = createOperationExecutionScope();
    const a = root(scope);
    const b = root(scope);
    expect(a.record(staged("x", 1)).seq).toBe(1);
    expect(b.record(staged("y", 2)).seq).toBe(2);
    expect(a.record(staged("z", 3)).seq).toBe(3);
  });

  it("retains detached copies of every root's records without private writes", () => {
    const scope = createOperationExecutionScope();
    const parent = root(scope);
    const child = root(scope);
    parent.record(staged("a", "private parent value"));
    child.record(staged("b", "private child value"));
    const nested = child.attachTo({} as RuntimeResult, true);
    parent.attachTo({} as RuntimeResult, false);
    const records = scope
      .records()
      .slice()
      .sort((a, b) => a.seq - b.seq);
    expect(records.map((record) => record.status)).toEqual([
      "discarded",
      "staged",
    ]);
    expect(JSON.stringify(records)).not.toContain("private");
    expect(records[1]).toEqual(nested.operations![0]);
    expect(records[1]).not.toBe(nested.operations![0]);
    expect(scope.records()[0]).not.toBe(scope.records()[0]);
  });

  it("shows later readers the writes of every live operation for one provider, in call order", () => {
    const stage = root();
    const child = stage.child();
    stage.record(staged("a", 1));
    child.record(staged("b", 2));
    stage.record(staged("c", 3, "notes"));
    expect(stage.stagedWrites("bank").map((p) => p.id)).toEqual([
      "proposal-a",
      "proposal-b",
    ]);
    child.discard();
    expect(stage.stagedWrites("bank").map((p) => p.id)).toEqual(["proposal-a"]);
  });

  it("moves a committed child's operations up and discards a parent's open children with it", () => {
    const stage = root();
    const outer = stage.child();
    const inner = outer.child();
    inner.record(staged("a", 1));
    inner.commit();
    expect(outer.held()).toHaveLength(1);
    const open = outer.child();
    open.record(staged("b", 2));
    outer.discard();
    expect(stage.held()).toEqual([]);
    expect(stage.stagedWrites("bank")).toEqual([]);
    expect(() => outer.child()).toThrow();
  });

  it("serializes holders of one provider's lock and lets other providers run", async () => {
    const stage = root();
    const order: string[] = [];
    const first = await stage.lock("bank");
    const second = stage
      .child()
      .lock("bank")
      .then((release) => {
        order.push("bank 2");
        return release;
      });
    const other = await stage.lock("notes");
    order.push("notes");
    await Promise.resolve();
    expect(order).toEqual(["notes"]);
    first();
    first();
    (await second)();
    other();
    expect(order).toEqual(["notes", "bank 2"]);
  });

  it("attaches staged operations with their writes to a successful result, once", () => {
    const stage = root();
    const dropped = stage.child();
    const op = stage.record(staged("a", 1));
    dropped.record(staged("b", 2));
    const result = {} as RuntimeResult;
    stage.attachTo(result, true);
    stage.attachTo(result, false);
    expect(result.operations?.map((record) => record.status)).toEqual([
      "staged",
      "discarded",
    ]);
    expect(result.operations?.[1]?.reason).toBe("caller-dropped");
    expect(Object.keys(result.operationWrites ?? {})).toEqual([op.id]);
    expect(hasOperationWrites([result])).toBe(true);
    expect(() => stage.record(staged("c", 3))).toThrow();
  });

  it("takes everything back on a failed result", () => {
    const stage = root();
    stage.record(staged("a", 1));
    const result = {} as RuntimeResult;
    stage.attachTo(result, false);
    expect(result.operations?.[0]?.status).toBe("discarded");
    expect(result.operationWrites).toBeUndefined();
    expect(hasOperationWrites([result])).toBe(false);
  });

  it("loads a provider's datasets once and fails a call when they cannot be loaded", async () => {
    const load = vi.fn(async (pluginId: string) =>
      pluginId === "bank"
        ? {
            datasets: { balances: { namespace: "balances", ops: [] } },
            schemas: {},
          }
        : undefined,
    );
    const scope = createOperationExecutionScope(load);
    await scope.prepareProvider("bank");
    await scope.prepareProvider("bank");
    expect(load).toHaveBeenCalledTimes(1);
    await expect(scope.prepareProvider("ghost")).rejects.toThrow();
    expect(Object.keys(scope.providerDatasets())).toEqual(["bank"]);
  });
});

describe("operation records", () => {
  const base = {
    id: "op",
    seq: 1,
    contract: "bank.change@1",
    providerPluginId: "bank",
    service: "change",
    invokedBy: { pluginId: "shop", runtimeId: "shop/trade", runId: "run" },
    writes: [],
  };

  it("keeps only the caller's plugin and runtime, and model-facing payloads", () => {
    const record = buildOperationRecord(
      {
        ...base,
        request: {
          item: "sword",
          id: "3f2b8c1e-8d1a-4c55-9a3e-1b2c3d4e5f60",
          createdAt: "2026-10-30T00:00:00.000Z",
        },
        result: { balance: 3 },
      },
      { status: "staged" },
    );
    expect(record.invokedBy).toEqual({
      pluginId: "shop",
      runtimeId: "shop/trade",
    });
    const text = JSON.stringify([
      record.summary,
      record.request,
      record.result,
    ]);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(text).not.toContain("2026-10-30");
    expect(record.summary.length).toBeLessThanOrEqual(
      OPERATION_SUMMARY_MAX_CHARS,
    );
  });

  it("drops a payload above the size limit and says so", () => {
    const record = buildOperationRecord(
      {
        ...base,
        request: { text: "x".repeat(OPERATION_PAYLOAD_MAX_BYTES) },
        result: { ok: true },
      },
      { status: "failed", reason: "conflict" },
    );
    expect(record.request).toBeUndefined();
    expect(record.result).toEqual({ ok: true });
    expect(record.truncated).toBe(true);
    expect(record.reason).toBe("conflict");
    expect(record.summary).toHaveLength(OPERATION_SUMMARY_MAX_CHARS);
  });

  it("lists the records of several results in call order", () => {
    const one = buildOperationRecord(
      { ...base, id: "b", seq: 2, request: {}, result: {} },
      { status: "staged" },
    );
    const two = buildOperationRecord(
      { ...base, id: "a", seq: 1, request: {}, result: {} },
      { status: "staged" },
    );
    expect(
      operationRecordsOf([{ operations: [one] }, { operations: [two] }]).map(
        (record) => record.id,
      ),
    ).toEqual(["a", "b"]);
  });
});
