/**
 * Regression tests for DAG scheduler optional input bindings (`required: false`),
 * `after` edges to independent cycles, and `cardinality: "one"` capability input
 * bindings when an alternative provider sits in a separate cycle.
 */

import { describe, expect, it } from "vitest";
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

function levelsOf(result: ReturnType<typeof scheduleByDag>): string[][] {
  return result.groups.map((group) => group.runtimes.map((r) => r.name));
}

describe("scheduleByDag optional bindings and cyclic producers", () => {
  it("does not drag an acyclic consumer with an optional runtime input binding into a producer cycle", () => {
    const cycleA = rt("p/cycle-a", { needs: ["p/cycle-b"] });
    const cycleB = rt("p/cycle-b", { needs: ["p/cycle-a"] });
    const consumer = rt("p/consumer", {
      inputs: {
        extra: { from: { runtime: "p/cycle-a" }, required: false },
      },
    });
    const downstream = rt("p/downstream", { needs: ["p/consumer"] });

    const result = scheduleByDag([cycleA, cycleB, consumer, downstream]);

    expect(levelsOf(result)).toEqual([["p/consumer"], ["p/downstream"]]);
    expect(result.cyclic?.map((r) => r.name).sort()).toEqual([
      "p/cycle-a",
      "p/cycle-b",
    ]);
  });

  it("still orders an optional binding after acyclic upstreams while ignoring a dead cyclic producer", () => {
    const ok = rt("p/ok");
    const cycleA = rt("p/cycle-a", { needs: ["p/cycle-b"] });
    const cycleB = rt("p/cycle-b", { needs: ["p/cycle-a"] });
    const consumer = rt("p/consumer", {
      inputs: {
        req: { from: { runtime: "p/ok" }, required: true },
        opt: { from: { runtime: "p/cycle-a" }, required: false },
      },
    });

    const result = scheduleByDag([ok, cycleA, cycleB, consumer]);

    expect(levelsOf(result)).toEqual([["p/ok"], ["p/consumer"]]);
    expect(result.cyclic?.map((r) => r.name).sort()).toEqual([
      "p/cycle-a",
      "p/cycle-b",
    ]);
  });

  it("does not drag an acyclic consumer with an optional capability binding into a cyclic provider", () => {
    const cycleA = rt("p/cycle-a", {
      outputContract: "hint@1",
      needs: ["p/cycle-b"],
    });
    const cycleB = rt("p/cycle-b", { needs: ["p/cycle-a"] });
    const consumer = rt("p/consumer", {
      inputs: {
        hint: { from: { capability: "hint@1" }, required: false },
      },
    });

    const result = scheduleByDag([cycleA, cycleB, consumer]);

    expect(levelsOf(result)).toEqual([["p/consumer"]]);
    expect(result.cyclic?.map((r) => r.name).sort()).toEqual([
      "p/cycle-a",
      "p/cycle-b",
    ]);
  });

  it("does not drag an acyclic consumer with an after edge into an independent cycle, while keeping hard needs cyclic", () => {
    const cycleA = rt("p/cycle-a", { needs: ["p/cycle-b"] });
    const cycleB = rt("p/cycle-b", { needs: ["p/cycle-a"] });
    const afterOnly = rt("p/after-only", { after: ["p/cycle-a"] });
    const hardNeeds = rt("p/hard-needs", { needs: ["p/cycle-a"] });

    const result = scheduleByDag([cycleA, cycleB, afterOnly, hardNeeds]);

    expect(levelsOf(result)).toEqual([["p/after-only"]]);
    expect(result.cyclic?.map((r) => r.name).sort()).toEqual([
      "p/cycle-a",
      "p/cycle-b",
      "p/hard-needs",
    ]);
  });
});

describe("scheduleByDag cardinality:one capability input bindings", () => {
  it.each([
    { label: "explicit cardinality: one", cardinality: "one" as const },
    { label: "default cardinality (omitted)", cardinality: undefined },
  ])(
    "releases consumer with $label capability input binding when one provider succeeds and another is cyclic",
    ({ cardinality }) => {
      const available = rt("p/engine-a", {
        outputContract: "narrative-engine@2",
      });
      const cyclicProvider = rt("p/engine-b", {
        outputContract: "narrative-engine@2",
        needs: ["p/cycle-peer"],
      });
      const cyclePeer = rt("p/cycle-peer", { needs: ["p/engine-b"] });
      const consumer = rt("p/consumer", {
        inputs: {
          story: {
            from: {
              capability: "narrative-engine@2",
              ...(cardinality ? { cardinality } : {}),
            },
          },
        },
      });

      const result = scheduleByDag([
        available,
        cyclicProvider,
        cyclePeer,
        consumer,
      ]);

      expect(levelsOf(result)).toEqual([["p/engine-a"], ["p/consumer"]]);
      expect(result.cyclic?.map((r) => r.name).sort()).toEqual([
        "p/cycle-peer",
        "p/engine-b",
      ]);
    },
  );

  it("releases consumer declaring both needs(one) and a cardinality:one capability input binding", () => {
    const available = rt("p/engine-a", {
      outputContract: "narrative-engine@2",
    });
    const cyclicProvider = rt("p/engine-b", {
      outputContract: "narrative-engine@2",
      needs: ["p/cycle-peer"],
    });
    const cyclePeer = rt("p/cycle-peer", { needs: ["p/engine-b"] });
    const consumer = rt("p/consumer", {
      needs: [{ capability: "narrative-engine@2", cardinality: "one" }],
      inputs: {
        story: { from: { capability: "narrative-engine@2" } },
      },
    });

    const result = scheduleByDag([
      available,
      cyclicProvider,
      cyclePeer,
      consumer,
    ]);

    expect(levelsOf(result)).toEqual([["p/engine-a"], ["p/consumer"]]);
    expect(result.cyclic?.map((r) => r.name).sort()).toEqual([
      "p/cycle-peer",
      "p/engine-b",
    ]);
  });

  it("keeps a required cardinality:all capability input binding cyclic when any provider is cyclic", () => {
    const available = rt("p/engine-a", {
      outputContract: "narrative-engine@2",
    });
    const cyclicProvider = rt("p/engine-b", {
      outputContract: "narrative-engine@2",
      needs: ["p/cycle-peer"],
    });
    const cyclePeer = rt("p/cycle-peer", { needs: ["p/engine-b"] });
    const consumer = rt("p/consumer", {
      inputs: {
        stories: {
          from: { capability: "narrative-engine@2", cardinality: "all" },
          required: true,
        },
      },
    });

    const result = scheduleByDag([
      available,
      cyclicProvider,
      cyclePeer,
      consumer,
    ]);

    expect(levelsOf(result)).toEqual([["p/engine-a"]]);
    expect(result.cyclic?.map((r) => r.name).sort()).toEqual([
      "p/consumer",
      "p/cycle-peer",
      "p/engine-b",
    ]);
  });

  it("keeps a required cardinality:one capability input binding cyclic when no provider can complete", () => {
    const cyclicProvider = rt("p/engine-b", {
      outputContract: "narrative-engine@2",
      needs: ["p/cycle-peer"],
    });
    const cyclePeer = rt("p/cycle-peer", { needs: ["p/engine-b"] });
    const consumer = rt("p/consumer", {
      inputs: {
        story: {
          from: { capability: "narrative-engine@2", cardinality: "one" },
          required: true,
        },
      },
    });

    const result = scheduleByDag([cyclicProvider, cyclePeer, consumer]);

    expect(levelsOf(result)).toEqual([]);
    expect(result.cyclic?.map((r) => r.name).sort()).toEqual([
      "p/consumer",
      "p/cycle-peer",
      "p/engine-b",
    ]);
  });
});
