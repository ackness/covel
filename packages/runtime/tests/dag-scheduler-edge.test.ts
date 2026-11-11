/**
 * DAG scheduler — edge cases beyond `dag-scheduler.test.ts`.
 *
 * These exercise corners that are easy to break during refactors:
 *  - self-loops (cycle of length 1)
 *  - silently dropping malformed `from` declarations instead of crashing
 *  - `needs + inputs` merge (no double-counting, no clash)
 *  - multi-runtime plugin name keying (`pluginId/runtimeName`)
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { scheduleByDag } from "../src/schedule/dag-scheduler.js";

function rt(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    runtimeType: "agent",
    stage: "narrative",
    ...overrides,
  };
}

function runtimeInputs(...names: readonly string[]): Partial<RuntimeManifest> {
  return {
    inputs: Object.fromEntries(
      names.map((n, i) => [`in${i}`, { from: { runtime: n } }]),
    ),
  };
}

describe("scheduleByDag — self-dependency", () => {
  it("flags a self-edge as a cycle and emits no levels", () => {
    const looped = rt("loop", runtimeInputs("loop"));
    const { groups, error } = scheduleByDag([looped]);
    expect(groups).toEqual([]);
    expect(error).toMatch(/cycle/i);
    expect(error).toMatch(/loop/);
  });
});

describe("scheduleByDag — malformed input declarations", () => {
  it('silently drops an empty-string runtime instead of treating it as a runtime named ""', () => {
    const a = rt("a");
    const b = rt("b", { inputs: { x: { from: { runtime: "" } } } });
    const { groups, error } = scheduleByDag([a, b]);
    expect(error).toBeUndefined();
    // Both runtimes can run on level 0 — `b` has no real dependency.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runtimes.map((r) => r.name).sort()).toEqual(["a", "b"]);
  });

  it("silently drops empty-string entries from needs", () => {
    const a = rt("a");
    const b = rt("b", { needs: ["", "a"] });
    const { groups, error } = scheduleByDag([a, b]);
    expect(error).toBeUndefined();
    expect(groups).toHaveLength(2);
    expect(groups[0]!.runtimes.map((r) => r.name)).toEqual(["a"]);
    expect(groups[1]!.runtimes.map((r) => r.name)).toEqual(["b"]);
  });
});

describe("scheduleByDag — needs + inputs merge", () => {
  it("does not double-count a dependency declared via both inputs and needs", () => {
    // If the algorithm naively summed input + needs edges without dedup,
    // `b` would have inDegree=2 and need TWO completions of `a` to clear,
    // which is impossible — the level would never form.
    const a = rt("a");
    const b = rt("b", {
      ...runtimeInputs("a"),
      needs: ["a"],
    });
    const { groups, error } = scheduleByDag([a, b]);
    expect(error).toBeUndefined();
    expect(groups).toHaveLength(2);
    expect(groups[1]!.runtimes.map((r) => r.name)).toEqual(["b"]);
  });

  it("needs adds an edge even when the same runtime has no input binding", () => {
    const root = rt("root");
    const sibling = rt("sibling");
    // `child` does not need `sibling`'s output, but execution order must wait.
    const child = rt("child", {
      ...runtimeInputs("root"),
      needs: ["sibling"],
    });
    const { groups } = scheduleByDag([root, sibling, child]);
    expect(groups[0]!.runtimes.map((r) => r.name).sort()).toEqual([
      "root",
      "sibling",
    ]);
    expect(groups[1]!.runtimes.map((r) => r.name)).toEqual(["child"]);
  });
});

describe("scheduleByDag — multi-runtime plugin identity", () => {
  it("keys edges on `pluginId/runtimeName`, not `pluginId`", () => {
    // Two siblings under the same plugin; downstream depends on one, not both.
    const schema = rt("world-init/schema-gen");
    const data = rt(
      "world-init/data-gen",
      runtimeInputs("world-init/schema-gen"),
    );
    const sibling = rt("world-init/audit");

    const { groups } = scheduleByDag([schema, data, sibling]);
    // Level 0 holds schema-gen + audit (both have no deps).
    expect(groups[0]!.runtimes.map((r) => r.name).sort()).toEqual([
      "world-init/audit",
      "world-init/schema-gen",
    ]);
    // Level 1 holds only data-gen.
    expect(groups[1]!.runtimes.map((r) => r.name)).toEqual([
      "world-init/data-gen",
    ]);
  });

  it("plugin-id-only override key does not establish an edge across siblings", () => {
    // A common authoring mistake is to inject `from: "codex"` instead of
    // `from: "codex/unlocker"`. The scheduler treats `codex` as out-of-scope
    // (no runtime by that exact name) and proceeds.
    const unlocker = rt("codex/unlocker");
    const retriever = rt("codex/retriever", runtimeInputs("codex"));
    const { groups, error } = scheduleByDag([unlocker, retriever]);
    expect(error).toBeUndefined();
    // No edge formed → both on level 0.
    expect(groups).toHaveLength(1);
  });
});

describe("scheduleByDag capability-one edge provenance", () => {
  const need = { capability: "data@1", cardinality: "one" as const };
  it.each([
    { after: ["p/b"] },
    { needs: [need, "p/b"] },
    { inputs: { data: { from: { runtime: "p/b" }, required: false } } },
    runtimeInputs("p/b"),
    { needs: [need, { capability: "data@1", cardinality: "all" as const }] },
  ])("preserves independent hard ordering constraints: %j", (hard) => {
    const a = rt("p/a", { outputContract: "data@1" });
    const b = rt("p/b", { outputContract: "data@1", after: ["p/c"] });
    const c = rt("p/c", { needs: [need], ...hard });
    const result = scheduleByDag([a, b, c]);
    expect(
      result.groups.map((group) => group.runtimes.map((r) => r.name)),
    ).toEqual([["p/a"]]);
    expect(result.cyclic?.map((r) => r.name)).toEqual(["p/b", "p/c"]);
  });

  it("still relaxes a pure OR provider barrier once an alternative completes", () => {
    const result = scheduleByDag([
      rt("p/a", { outputContract: "data@1" }),
      rt("p/b", { outputContract: "data@1", after: ["p/c"] }),
      rt("p/c", { needs: [need] }),
    ]);
    expect(result.error).toBeUndefined();
    expect(
      result.groups.map((group) => group.runtimes.map((r) => r.name)),
    ).toEqual([["p/a"], ["p/c"], ["p/b"]]);
  });
});
