/**
 * DAG scheduler — derives parallel levels from manifest.input.inject + needs.
 */

import { describe, it, expect } from "vitest";
import { scheduleByDag } from "../src/schedule/dag-scheduler.js";
import type { RuntimeManifest } from "@covel/shared";

function mk(
  name: string,
  priority: number,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    stage:
      priority <= 99
        ? "setup"
        : priority <= 499
          ? "pre-turn"
          : priority === 500
            ? "narrative"
            : priority <= 999
              ? "post-turn"
              : "audit",
    ...overrides,
  } as RuntimeManifest;
}

describe("scheduleByDag", () => {
  it("puts independent runtimes on the first level (can run in parallel)", () => {
    const input = [mk("rag", 490), mk("other", 495)];
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
      mk("npc-graph/rag-retriever", 490),
      mk("narrator", 500, {
        input: {
          inject: [
            {
              kind: "runtime",
              from: "npc-graph/rag-retriever",
              field: "npcContext",
              as: "<npc>",
            },
          ],
        },
      } as Partial<RuntimeManifest>),
      mk("guide", 550, {
        input: {
          inject: [
            {
              kind: "runtime",
              from: "narrator",
              field: "narrativeOutput",
              as: "<n>",
            },
          ],
        },
      } as Partial<RuntimeManifest>),
      mk("npc-graph/extractor", 620, {
        input: {
          inject: [
            {
              kind: "runtime",
              from: "narrator",
              field: "narrativeOutput",
              as: "<n>",
            },
          ],
        },
      } as Partial<RuntimeManifest>),
      mk("codex", 650, {
        input: {
          inject: [
            {
              kind: "runtime",
              from: "narrator",
              field: "narrativeOutput",
              as: "<n>",
            },
          ],
        },
      } as Partial<RuntimeManifest>),
      mk("char-creator/character-tracker", 750, {
        input: {
          inject: [
            {
              kind: "runtime",
              from: "narrator",
              field: "narrativeOutput",
              as: "<n>",
            },
          ],
        },
      } as Partial<RuntimeManifest>),
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

  it("needs adds an edge even without an inject declaration", () => {
    const input = [mk("a", 100), mk("b", 200, { needs: ["a"] })];
    const { groups } = scheduleByDag(input);
    expect(groups.length).toBe(2);
    expect(groups[0]!.runtimes.map((r) => r.name)).toEqual(["a"]);
    expect(groups[1]!.runtimes.map((r) => r.name)).toEqual(["b"]);
  });

  it("ignores plugin-data kind injects (not runtime deps)", () => {
    const input = [
      mk("codex", 650, {
        input: {
          inject: [
            {
              kind: "plugin-data",
              namespace: "entries",
              as: "<existing>",
            } as unknown,
          ] as RuntimeManifest["input"]["inject"],
        },
      } as Partial<RuntimeManifest>),
    ];
    const { groups } = scheduleByDag(input);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runtimes.map((r) => r.name)).toEqual(["codex"]);
  });

  it("ignores out-of-scope dependencies", () => {
    // downstream declares `from: 'not-scheduled'` which isn't in the input.
    const input = [
      mk("downstream", 500, {
        input: {
          inject: [
            { kind: "runtime", from: "not-scheduled", field: "x", as: "<x>" },
          ],
        },
      } as Partial<RuntimeManifest>),
    ];
    const { groups, error } = scheduleByDag(input);
    expect(error).toBeUndefined();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runtimes.map((r) => r.name)).toEqual(["downstream"]);
  });

  it("reports an error on cycles", () => {
    const input = [
      mk("a", 100, { needs: ["b"] }),
      mk("b", 200, { needs: ["a"] }),
    ];
    const { error } = scheduleByDag(input);
    expect(error).toMatch(/cycle/i);
  });

  it("orders same-level runtimes by name", () => {
    const input = [mk("z", 100), mk("a", 900), mk("m", 500)];
    const { groups } = scheduleByDag(input);
    expect(groups).toHaveLength(1);
    // Name order a<m<z, even though priority order would be z(100)<m(500)<a(900).
    expect(groups[0]!.runtimes.map((r) => r.name)).toEqual(["a", "m", "z"]);
  });

  it("returns empty when given no runtimes", () => {
    const { groups, error } = scheduleByDag([]);
    expect(groups).toEqual([]);
    expect(error).toBeUndefined();
  });
});
