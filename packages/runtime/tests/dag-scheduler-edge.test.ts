/**
 * DAG scheduler — edge cases beyond `dag-scheduler.test.ts`.
 *
 * These exercise corners that are easy to break during refactors:
 *  - self-loops (cycle of length 1)
 *  - same-priority alphabetical tiebreaker
 *  - silently dropping malformed `from` declarations instead of crashing
 *  - `upstreamRequired + input.inject` merge (no double-counting, no clash)
 *  - multi-runtime plugin name keying (`pluginId/runtimeName`)
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { scheduleByDag } from "../src/dag-scheduler.js";

function rt(
  name: string,
  priority: number,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    priority,
    ...overrides,
  } as RuntimeManifest;
}

function injectRuntime(...names: readonly string[]): Partial<RuntimeManifest> {
  return {
    input: {
      inject: names.map((n) => ({
        kind: "runtime",
        from: n,
        field: "narrativeOutput",
        as: "<x>",
      })),
    },
  } as Partial<RuntimeManifest>;
}

describe("scheduleByDag — self-dependency", () => {
  it("flags a self-edge as a cycle and emits no levels", () => {
    const looped = rt("loop", 100, injectRuntime("loop"));
    const { groups, error } = scheduleByDag([looped]);
    expect(groups).toEqual([]);
    expect(error).toMatch(/cycle/i);
    expect(error).toMatch(/loop/);
  });
});

describe("scheduleByDag — same-priority tiebreaker", () => {
  it("breaks ties alphabetically by name within a level", () => {
    // Insert in non-alphabetical, non-priority order. Output must be stable.
    const a = [rt("charlie", 500), rt("alpha", 500), rt("bravo", 500)];
    const { groups } = scheduleByDag(a);
    expect(groups[0].runtimes.map((r) => r.name)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  it("lower priority wins before alphabetical tiebreaker takes effect", () => {
    const a = [
      rt("zzzz", 100), // alphabetically last but lowest priority
      rt("aaaa", 200),
      rt("mmmm", 200),
    ];
    const { groups } = scheduleByDag(a);
    expect(groups[0].runtimes.map((r) => r.name)).toEqual([
      "zzzz",
      "aaaa",
      "mmmm",
    ]);
  });
});

describe("scheduleByDag — malformed inject declarations", () => {
  it('silently drops empty-string `from` instead of treating it as a runtime named ""', () => {
    const a = rt("a", 100);
    const b = rt("b", 200, {
      input: {
        inject: [{ kind: "runtime", from: "", field: "x", as: "<x>" } as never],
      },
    } as Partial<RuntimeManifest>);
    const { groups, error } = scheduleByDag([a, b]);
    expect(error).toBeUndefined();
    // Both runtimes can run on level 0 — `b` has no real dependency.
    expect(groups).toHaveLength(1);
    expect(groups[0].runtimes.map((r) => r.name).sort()).toEqual(["a", "b"]);
  });

  it("silently drops empty-string entries from upstreamRequired", () => {
    const a = rt("a", 100);
    const b = rt("b", 200, { upstreamRequired: ["", "a"] });
    const { groups, error } = scheduleByDag([a, b]);
    expect(error).toBeUndefined();
    expect(groups).toHaveLength(2);
    expect(groups[0].runtimes.map((r) => r.name)).toEqual(["a"]);
    expect(groups[1].runtimes.map((r) => r.name)).toEqual(["b"]);
  });
});

describe("scheduleByDag — upstreamRequired + inject merge", () => {
  it("does not double-count a dependency declared via both inject and upstreamRequired", () => {
    // If the algorithm naively summed inject + upstream edges without dedup,
    // `b` would have inDegree=2 and need TWO completions of `a` to clear,
    // which is impossible — the level would never form.
    const a = rt("a", 100);
    const b = rt("b", 200, {
      ...injectRuntime("a"),
      upstreamRequired: ["a"],
    });
    const { groups, error } = scheduleByDag([a, b]);
    expect(error).toBeUndefined();
    expect(groups).toHaveLength(2);
    expect(groups[1].runtimes.map((r) => r.name)).toEqual(["b"]);
  });

  it("upstreamRequired adds an edge even when the same runtime is not injected", () => {
    const root = rt("root", 100);
    const sibling = rt("sibling", 110);
    // `child` does not need `sibling`'s output, but execution order must wait.
    const child = rt("child", 200, {
      ...injectRuntime("root"),
      upstreamRequired: ["sibling"],
    });
    const { groups } = scheduleByDag([root, sibling, child]);
    expect(groups[0].runtimes.map((r) => r.name).sort()).toEqual([
      "root",
      "sibling",
    ]);
    expect(groups[1].runtimes.map((r) => r.name)).toEqual(["child"]);
  });
});

describe("scheduleByDag — multi-runtime plugin identity", () => {
  it("keys edges on `pluginId/runtimeName`, not `pluginId`", () => {
    // Two siblings under the same plugin; downstream depends on one, not both.
    const schema = rt("world-init/schema-gen", 50);
    const data = rt(
      "world-init/data-gen",
      60,
      injectRuntime("world-init/schema-gen"),
    );
    const sibling = rt("world-init/audit", 55);

    const { groups } = scheduleByDag([schema, data, sibling]);
    // Level 0 holds schema-gen + audit (both have no deps).
    expect(groups[0].runtimes.map((r) => r.name).sort()).toEqual([
      "world-init/audit",
      "world-init/schema-gen",
    ]);
    // Level 1 holds only data-gen.
    expect(groups[1].runtimes.map((r) => r.name)).toEqual([
      "world-init/data-gen",
    ]);
  });

  it("plugin-id-only override key does not establish an edge across siblings", () => {
    // A common authoring mistake is to inject `from: "codex"` instead of
    // `from: "codex/unlocker"`. The scheduler treats `codex` as out-of-scope
    // (no runtime by that exact name) and proceeds.
    const unlocker = rt("codex/unlocker", 600);
    const retriever = rt("codex/retriever", 610, injectRuntime("codex"));
    const { groups, error } = scheduleByDag([unlocker, retriever]);
    expect(error).toBeUndefined();
    // No edge formed → both on level 0.
    expect(groups).toHaveLength(1);
  });
});
