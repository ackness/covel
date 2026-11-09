import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationRecord, Proposal, RuntimeManifest } from "@covel/shared";
import {
  applyIsolatedRuntimes,
  commitUnitsOf,
  DroppedUnits,
  isolationPolicy,
  lostProducerName,
  unitDependencies,
  type CommitUnit,
} from "../src/commit/commit-isolation.js";
import { OperationLedger } from "../src/commit/operation-ledger.js";
import type { FinalizableResult } from "../src/commit/finalize-types.js";

function manifest(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: "probe",
    description: name,
    stage: "post-turn",
    outputKind: "system",
    ...overrides,
  };
}

function result(
  runtimeId: string,
  overrides: Partial<FinalizableResult> = {},
): FinalizableResult {
  return {
    pluginId: "probe",
    runtimeId,
    turnId: "turn",
    runId: `run-${runtimeId}`,
    status: "success",
    output: {},
    ...overrides,
  };
}

function unit(...members: FinalizableResult[]): CommitUnit {
  return { root: members.at(-1)!, members };
}

const write: Proposal = {
  id: "write",
  type: "plugin.data",
  sessionId: "session",
  turnId: "turn",
  source: { pluginId: "probe", runtimeId: "probe/writer" },
  payload: { namespace: "notes", key: "k", value: "v" },
  timestamp: "2026-11-09T00:00:00.000Z",
};

function operation(id: string, seq: number): OperationRecord {
  return {
    id,
    contract: "change@1",
    providerPluginId: "provider",
    service: "change",
    invokedBy: { pluginId: "probe", runtimeId: "probe/caller" },
    seq,
    status: "staged",
    summary: "change",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("commitUnitsOf", () => {
  it("makes each result its own unit without unit sizes", () => {
    const a = result("a");
    const b = result("b");
    expect(commitUnitsOf([a, b], undefined)).toEqual([unit(a), unit(b)]);
  });

  it("groups children before their parent, the parent last", () => {
    const child = result("child");
    const parent = result("parent");
    const other = result("other");
    const units = commitUnitsOf([child, parent, other], [2, 1]);
    expect(units).toHaveLength(2);
    expect(units[0]!.root).toBe(parent);
    expect(units[0]!.members).toEqual([child, parent]);
    expect(units[1]!.root).toBe(other);
  });

  it.each([
    [[1], 1],
    [[0, 3], 0],
    [[2, 2], 2],
  ])("refuses sizes %j that do not cover every result", (sizes, covered) => {
    expect(() =>
      commitUnitsOf([result("a"), result("b"), result("c")], sizes),
    ).toThrow(
      `commitUnits cover ${covered} of 3 results; the commit plan is malformed`,
    );
  });
});

describe("isolationPolicy", () => {
  const story = manifest("story", { outputKind: "story" });
  const setup = manifest("setup", { stage: "setup" });
  const plain = manifest("plain");
  const runtimes = [story, setup, plain];
  const kinds = new Map(runtimes.map((rt) => [rt.name, rt.outputKind!]));
  const kindOf = (r: FinalizableResult) => kinds.get(r.runtimeId) ?? "system";

  it("keeps an execution without a committed story all-or-nothing", () => {
    for (const storyStatus of ["failed", "skipped"] as const) {
      const results = [
        result("story", { status: storyStatus }),
        result("plain"),
      ];
      const policy = isolationPolicy({ results, runtimes, kindOf });
      expect(policy.hasStory).toBe(false);
      expect(policy.isolates(unit(results[1]!))).toBe(false);
    }
  });

  it("isolates units with neither a story nor a setup run next to a story", () => {
    const results = [result("story"), result("plain"), result("setup")];
    const policy = isolationPolicy({ results, runtimes, kindOf });
    expect(policy.hasStory).toBe(true);
    expect(policy.isolates(unit(result("plain")))).toBe(true);
    expect(policy.isolates(unit(result("story")))).toBe(false);
    // Known as setup by its manifest's stage.
    expect(policy.isolates(unit(result("setup")))).toBe(false);
  });

  it("protects a unit holding a story or setup run anywhere, even nested", () => {
    const results = [result("story")];
    const policy = isolationPolicy({ results, runtimes, kindOf });
    expect(
      policy.isolates(
        unit(result("story", { runId: "nested" }), result("plain")),
      ),
    ).toBe(false);
    expect(
      policy.isolates(
        unit(result("setup", { runId: "nested" }), result("plain")),
      ),
    ).toBe(false);
  });

  it("protects a setup runtime the execution scheduled, whatever its stage", () => {
    const results = [result("story"), result("plain")];
    const policy = isolationPolicy({
      results,
      runtimes,
      kindOf,
      setupRan: [{ runtimeId: "plain" }],
    });
    expect(policy.protects(results[1]!)).toBe(true);
    expect(policy.isolates(unit(results[1]!))).toBe(false);
  });
});

describe("DroppedUnits", () => {
  it("reports each dropped run in drop order, nested ones as dropped with their root", () => {
    const drops = new DroppedUnits();
    const child = result("child");
    const parent = result("parent");
    const other = result("other");
    drops.drop(unit(other), { error: "refused", cause: "rejected" });
    drops.drop(unit(child, parent), { error: "needs up", cause: "upstream" });

    expect(drops.size).toBe(2);
    expect(drops.rootIds()).toEqual(new Set(["other", "parent"]));
    expect(drops.runs()).toEqual(new Set([other, child, parent]));
    expect(drops.isolatedRuntimes()).toEqual([
      {
        runtimeId: "other",
        runId: "run-other",
        cause: "rejected",
        error: "refused",
      },
      {
        runtimeId: "child",
        runId: "run-child",
        cause: "nested",
        error: "dropped with parent: needs up",
      },
      {
        runtimeId: "parent",
        runId: "run-parent",
        cause: "upstream",
        error: "needs up",
      },
    ]);
  });

  it("gives every step after the units the same settled view until another drop", () => {
    const drops = new DroppedUnits();
    const a = result("a");
    drops.drop(unit(a), { error: "refused", cause: "rejected" });
    const first = drops.settled();
    expect(drops.settled()).toBe(first);
    expect(first.runIds).toEqual(new Set(["run-a"]));

    const b = result("b");
    drops.drop(unit(b), { error: "read", cause: "read" });
    const second = drops.settled();
    expect(second).not.toBe(first);
    expect(second.rootIds).toEqual(new Set(["a", "b"]));
    expect(first.rootIds).toEqual(new Set(["a"]));
  });

  it("matches a dropped run by run id, and by top-level runtime without one", () => {
    const drops = new DroppedUnits();
    drops.drop(unit(result("child"), result("parent")), {
      error: "refused",
      cause: "rejected",
    });
    const { runDropped } = drops.settled();
    expect(runDropped("run-child", undefined)).toBe(true);
    expect(runDropped("run-other", "parent")).toBe(false);
    expect(runDropped(undefined, "parent")).toBe(true);
    // Only top-level runtimes are matched without a run id.
    expect(runDropped(undefined, "child")).toBe(false);
    expect(runDropped(undefined, undefined)).toBe(false);
  });
});

describe("unitDependencies", () => {
  function setup(options: {
    readonly results: FinalizableResult[];
    readonly units: CommitUnit[];
    readonly runtimes?: RuntimeManifest[];
    readonly writes?: ReadonlyMap<FinalizableResult, number>;
    readonly readDependencies?: Record<string, string[]>;
    readonly suspensionRuns?: Record<string, string>;
  }) {
    const drops = new DroppedUnits();
    const ledger = new OperationLedger(options.results, undefined);
    const deps = unitDependencies({
      runtimes: options.runtimes ?? [],
      results: options.results,
      units: options.units,
      prepared: new Map(
        options.results.map((r) => [
          r,
          { proposals: Array(options.writes?.get(r) ?? 0).fill(write) },
        ]),
      ),
      ...(options.readDependencies
        ? { readDependencies: options.readDependencies }
        : {}),
      ...(options.suspensionRuns
        ? { suspensionRuns: options.suspensionRuns }
        : {}),
      operations: ledger,
      drops,
    });
    return { deps, drops, ledger };
  }

  describe("lostUpstreamOf", () => {
    const runtimes = [manifest("up"), manifest("down", { needs: ["up"] })];

    it("names a hard upstream dropped so far", () => {
      const up = result("up");
      const down = result("down");
      const { deps, drops } = setup({
        results: [up, down],
        units: [unit(up), unit(down)],
        runtimes,
      });
      expect(deps.lostUpstreamOf(unit(down))).toBeUndefined();
      drops.drop(unit(up), { error: "refused", cause: "rejected" });
      expect(deps.lostUpstreamOf(unit(down))).toBe("up");
    });

    it("ignores the upstream of a root that neither succeeded nor has writes", () => {
      const up = result("up");
      const down = result("down", { status: "skipped" });
      const { deps, drops } = setup({
        results: [up, down],
        units: [unit(up), unit(down)],
        runtimes,
      });
      drops.drop(unit(up), { error: "refused", cause: "rejected" });
      expect(deps.lostUpstreamOf(unit(down))).toBeUndefined();
    });

    it("checks a skipped root that still has writes to commit", () => {
      const up = result("up");
      const down = result("down", { status: "skipped" });
      const { deps, drops } = setup({
        results: [up, down],
        units: [unit(up), unit(down)],
        runtimes,
        writes: new Map([[down, 1]]),
      });
      drops.drop(unit(up), { error: "refused", cause: "rejected" });
      expect(deps.lostUpstreamOf(unit(down))).toBe("up");
    });
  });

  describe("lostReadsOf", () => {
    it("returns the dropped producers a unit's members read, once each", () => {
      const producer = result("producer");
      const child = result("child");
      const reader = result("reader");
      const { deps, drops } = setup({
        results: [producer, child, reader],
        units: [unit(producer), unit(child, reader)],
        readDependencies: {
          "run-child": ["run-producer"],
          "run-reader": ["run-producer", "unknown"],
        },
      });
      expect(deps.lostReadsOf(unit(child, reader))).toEqual([]);
      drops.drop(unit(producer), { error: "refused", cause: "rejected" });
      const lost = deps.lostReadsOf(unit(child, reader));
      expect(lost).toEqual([{ reader: child, producer }]);
      expect(lostProducerName(lost[0]!)).toBe("producer");
    });

    it("ignores reads inside the unit and of producers that commit later", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const child = result("child");
      const reader = result("reader");
      const later = result("later");
      const { deps, drops } = setup({
        results: [child, reader, later],
        units: [unit(child, reader), unit(later)],
        readDependencies: { "run-reader": ["run-child", "run-later"] },
      });
      drops.drop(unit(later), { error: "refused", cause: "rejected" });
      expect(deps.lostReadsOf(unit(child, reader))).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        "[finalize-execution] reader read data of later, which commits after it; the dependency is ignored",
      );
    });

    it("counts a read of a dropped write-service operation of another unit", () => {
      const caller = result("caller", {
        operations: [operation("op", 1)],
        operationWrites: { op: [write] },
      });
      const reader = result("reader");
      const { deps, ledger } = setup({
        results: [caller, reader],
        units: [unit(caller), unit(reader)],
        readDependencies: { "run-reader": ["op"] },
      });
      const entry = ledger.entry("op")!;
      expect(deps.lostReadsOf(unit(reader))).toEqual([]);
      ledger.settle(entry, "failed", "rejected");
      const lost = deps.lostReadsOf(unit(reader));
      expect(lost).toEqual([{ reader, operation: entry }]);
      expect(lostProducerName(lost[0]!)).toBe("change@1");
    });

    it("ignores an operation of the reader's own unit or of a later one", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const reader = result("reader", {
        operations: [operation("own", 1)],
        operationWrites: { own: [write] },
      });
      const later = result("later", {
        operations: [operation("later-op", 2)],
        operationWrites: { "later-op": [write] },
      });
      const { deps, ledger } = setup({
        results: [reader, later],
        units: [unit(reader), unit(later)],
        readDependencies: { "run-reader": ["own", "later-op"] },
      });
      ledger.settle(ledger.entry("own")!, "failed", "rejected");
      ledger.settle(ledger.entry("later-op")!, "failed", "rejected");
      expect(deps.lostReadsOf(unit(reader))).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        "[finalize-execution] reader read data written through change@1, which commits after it; the dependency is ignored",
      );
    });

    it("checks a unit with nothing to commit only when it holds a continuation", () => {
      const producer = result("producer");
      const reader = result("reader", { status: "suspended" });
      const edges = { "run-reader": ["run-producer"] };
      const plain = setup({
        results: [producer, reader],
        units: [unit(producer), unit(reader)],
        readDependencies: edges,
      });
      plain.drops.drop(unit(producer), { error: "refused", cause: "rejected" });
      expect(plain.deps.lostReadsOf(unit(reader))).toEqual([]);

      const suspended = setup({
        results: [producer, reader],
        units: [unit(producer), unit(reader)],
        readDependencies: edges,
        suspensionRuns: { suspension: "run-reader" },
      });
      suspended.drops.drop(unit(producer), {
        error: "refused",
        cause: "rejected",
      });
      expect(suspended.deps.lostReadsOf(unit(reader))).toEqual([
        { reader, producer },
      ]);
    });
  });
});

describe("applyIsolatedRuntimes", () => {
  it("reads a dropped run as failed, matching by run id before runtime id", () => {
    const results = [
      { runtimeId: "a", runId: "a-1", status: "success" },
      { runtimeId: "a", runId: "a-2", status: "success" },
      { runtimeId: "b", status: "success" },
      { runtimeId: "c", runId: "c-1", status: "success" },
    ];
    expect(
      applyIsolatedRuntimes(results, [
        { runtimeId: "a", runId: "a-2", cause: "nested", error: "nested drop" },
        { runtimeId: "b", cause: "rejected", error: "refused" },
      ]),
    ).toEqual([
      results[0],
      { runtimeId: "a", runId: "a-2", status: "failed", error: "nested drop" },
      { runtimeId: "b", status: "failed", error: "refused" },
      results[3],
    ]);
    expect(applyIsolatedRuntimes(results, undefined)).toEqual(results);
  });
});
