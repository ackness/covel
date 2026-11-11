/**
 * DAG scheduler — derives parallel levels from inputs, needs and after.
 */

import { describe, it, expect } from "vitest";
import { scheduleByDag } from "../src/schedule/dag-scheduler.js";
import type { RuntimeManifest } from "@covel/shared";

function mk(
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

describe("scheduleByDag", () => {
  it("puts independent runtimes on the first level (can run in parallel)", () => {
    const input = [mk("rag"), mk("other")];
    const { groups, error } = scheduleByDag(input);
    expect(error).toBeUndefined();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runtimes.map((r) => r.name).sort()).toEqual([
      "other",
      "rag",
    ]);
  });

  it("parallelises all narrator downstreams after narrator completes", () => {
    const input = [
      mk("npc-graph/rag-retriever"),
      mk("narrator", {
        inputs: { npc: { from: { runtime: "npc-graph/rag-retriever" } } },
      }),
      mk("guide", {
        inputs: { n: { from: { runtime: "narrator" } } },
      }),
      mk("npc-graph/extractor", {
        inputs: { n: { from: { runtime: "narrator" } } },
      }),
      mk("codex", {
        inputs: { n: { from: { runtime: "narrator" } } },
      }),
      mk("char-creator/character-tracker", {
        inputs: { n: { from: { runtime: "narrator" } } },
      }),
    ];

    const { groups, error } = scheduleByDag(input);
    expect(error).toBeUndefined();
    expect(groups.length).toBe(3);

    // Level 0: rag (no deps)
    expect(groups[0]!.runtimes.map((r) => r.name)).toEqual([
      "npc-graph/rag-retriever",
    ]);

    // Level 1: narrator (depends on rag)
    expect(groups[1]!.runtimes.map((r) => r.name)).toEqual(["narrator"]);

    // Level 2: everything that depends only on narrator — all parallel.
    expect(groups[2]!.runtimes.map((r) => r.name).sort()).toEqual(
      [
        "char-creator/character-tracker",
        "codex",
        "guide",
        "npc-graph/extractor",
      ].sort(),
    );
  });

  it("needs orders runtimes without an input binding", () => {
    const input = [mk("a"), mk("b", { needs: ["a"] })];
    const { groups } = scheduleByDag(input);
    expect(groups.length).toBe(2);
    expect(groups[0]!.runtimes.map((r) => r.name)).toEqual(["a"]);
    expect(groups[1]!.runtimes.map((r) => r.name)).toEqual(["b"]);
  });

  it("does not pull a cardinality-one consumer into an alternative provider cycle", () => {
    const available = mk("engine-a", {
      outputContract: "narrative-engine@2",
    });
    const cyclicProvider = mk("engine-b", {
      outputContract: "narrative-engine@2",
      needs: ["cycle-peer"],
    });
    const cyclePeer = mk("cycle-peer", { needs: ["engine-b"] });
    const consumer = mk("guide", {
      needs: [{ capability: "narrative-engine@2", cardinality: "one" }],
    });

    const { groups, cyclic } = scheduleByDag([
      available,
      cyclicProvider,
      cyclePeer,
      consumer,
    ]);

    expect(groups.map((group) => group.runtimes.map((rt) => rt.name))).toEqual([
      ["engine-a"],
      ["guide"],
    ]);
    expect(cyclic?.map((rt) => rt.name).sort()).toEqual([
      "cycle-peer",
      "engine-b",
    ]);
  });

  it("keeps cardinality-all consumers downstream of every provider cycle", () => {
    const available = mk("engine-a", {
      outputContract: "narrative-engine@2",
    });
    const cyclicProvider = mk("engine-b", {
      outputContract: "narrative-engine@2",
      needs: ["cycle-peer"],
    });
    const cyclePeer = mk("cycle-peer", { needs: ["engine-b"] });
    const consumer = mk("guide", {
      needs: [{ capability: "narrative-engine@2", cardinality: "all" }],
    });

    const { groups, cyclic } = scheduleByDag([
      available,
      cyclicProvider,
      cyclePeer,
      consumer,
    ]);

    expect(groups.map((group) => group.runtimes.map((rt) => rt.name))).toEqual([
      ["engine-a"],
    ]);
    expect(cyclic?.map((rt) => rt.name).sort()).toEqual([
      "cycle-peer",
      "engine-b",
      "guide",
    ]);
  });

  it("ignores out-of-scope dependencies", () => {
    // downstream declares `from: 'not-scheduled'` which isn't in the input.
    const input = [
      mk("downstream", {
        inputs: { x: { from: { runtime: "not-scheduled" } } },
      }),
    ];
    const { groups, error } = scheduleByDag(input);
    expect(error).toBeUndefined();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runtimes.map((r) => r.name)).toEqual(["downstream"]);
  });

  it("reports an error on cycles", () => {
    const input = [mk("a", { needs: ["b"] }), mk("b", { needs: ["a"] })];
    const { error } = scheduleByDag(input);
    expect(error).toMatch(/cycle/i);
  });

  it("orders same-level runtimes by name", () => {
    const input = [mk("z"), mk("a"), mk("m")];
    const { groups } = scheduleByDag(input);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runtimes.map((r) => r.name)).toEqual(["a", "m", "z"]);
  });

  it("returns empty when given no runtimes", () => {
    const { groups, error } = scheduleByDag([]);
    expect(groups).toEqual([]);
    expect(error).toBeUndefined();
  });
});
