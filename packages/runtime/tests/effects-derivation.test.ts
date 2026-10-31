/**
 * Effects read/write derivation + same-layer hazard policy (01 §7).
 *
 * Covers: the builtin-tool → resource-key mapping table, the intersection rule
 * (complete key / namespace wildcard / unknown:*), the hazard matrix
 * (W/W · W/R · R/W hazards, R/R exempt), the parallelSafe exemption, and both
 * policies' stable output (warn = diagnostics only; strict = deterministic
 * serial re-layering).
 */

import { describe, it, expect } from "vitest";
import type { EffectResource, RuntimeManifest } from "@covel/shared";
import {
  deriveEffects,
  resourcesIntersect,
  effectsHazard,
  applyHazardPolicy,
  type RuntimeEffects,
} from "../src/schedule/effects.js";
import type { ScheduledGroup } from "../src/types.js";

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: "p/rt",
    pluginId: "p",
    stage: "narrative",
    trigger: { type: "auto" },
    model: "gpt-4o-mini",
    runtimeType: "agent",
    ...overrides,
  } as RuntimeManifest;
}

const asSet = (r: ReadonlySet<EffectResource>) => [...r].sort();

describe("deriveEffects — builtin tool mapping table", () => {
  it("maps character tools to characters:*", () => {
    const w = deriveEffects(
      manifest({
        tools: { builtin: ["sync-characters"] },
      }),
    );
    expect(asSet(w.writes)).toEqual(["characters:*"]);
    expect(asSet(w.reads)).toEqual(["characters:*"]);

    const r = deriveEffects(
      manifest({ tools: { builtin: ["get-character", "list-characters"] } }),
    );
    expect(asSet(r.reads)).toEqual(["characters:*"]);
    expect(asSet(r.writes)).toEqual([]);

    const sync = deriveEffects(
      manifest({ tools: { builtin: ["sync-characters"] } }),
    );
    expect(asSet(sync.reads)).toEqual(["characters:*"]);
    expect(asSet(sync.writes)).toEqual(["characters:*"]);
  });

  it("maps ui tools: render-ui/create-notification → ui:*, create-form/create-choices → interaction:*", () => {
    const e = deriveEffects(
      manifest({
        tools: {
          builtin: [
            "render-ui",
            "create-notification",
            "create-form",
            "create-choices",
          ],
        },
      }),
    );
    expect(asSet(e.writes)).toEqual(["interaction:*", "ui:*"]);
  });

  it("maps plugin-data-set to per-namespace self keys when dataSchemas are declared", () => {
    const e = deriveEffects(
      manifest({
        tools: { builtin: ["plugin-data-set", "plugin-data-set-batch"] },
        dataSchemas: {
          inventory: {
            namespace: "inventory",
            schemaVersion: 1,
            acceptsWorldData: false,
            schema: "./s.json",
          },
          quests: {
            namespace: "quests",
            schemaVersion: 1,
            acceptsWorldData: false,
            schema: "./q.json",
          },
        },
      }),
    );
    expect(asSet(e.writes)).toEqual([
      "plugin-data:self:inventory",
      "plugin-data:self:quests",
    ]);
  });

  it("collapses plugin-data with no dataSchemas to the conservative unknown:*", () => {
    const w = deriveEffects(
      manifest({ tools: { builtin: ["plugin-data-set"] } }),
    );
    expect(asSet(w.writes)).toEqual(["unknown:*"]);
    const r = deriveEffects(
      manifest({ tools: { builtin: ["plugin-data-get"] } }),
    );
    expect(asSet(r.reads)).toEqual(["unknown:*"]);
  });

  it("maps dataset tools to their dataset's self key: reads for get/list, writes for upsert/update", () => {
    const e = deriveEffects(
      manifest({
        tools: {
          datasets: [
            { dataset: "npcs", tools: ["get", "list", "upsert", "update"] },
            { dataset: "clock", tools: ["get"] },
            { dataset: "log", tools: ["upsert"] },
          ],
        },
      }),
    );
    expect(asSet(e.reads)).toEqual([
      "plugin-data:self:clock",
      "plugin-data:self:npcs",
    ]);
    expect(asSet(e.writes)).toEqual([
      "plugin-data:self:log",
      "plugin-data:self:npcs",
    ]);
    const update = deriveEffects(
      manifest({
        tools: { datasets: [{ dataset: "npcs", tools: ["update"] }] },
      }),
    );
    expect(asSet(update.reads)).toEqual([]);
    expect(asSet(update.writes)).toEqual(["plugin-data:self:npcs"]);
  });

  it("maps emit-event to event:*; effects.writes adds exact topics", () => {
    const emitter = deriveEffects(
      manifest({ tools: { builtin: ["emit-event"] } }),
    );
    expect(asSet(emitter.writes)).toEqual(["event:*"]);

    const declared = deriveEffects(
      manifest({
        tools: { builtin: ["emit-event"] },
        effects: { writes: ["event:scene.set"] },
      }),
    );
    expect(asSet(declared.writes)).toEqual(["event:*", "event:scene.set"]);
  });

  it("derives narrative:* from outputKind story", () => {
    const e = deriveEffects(manifest({ outputKind: "story" }));
    expect(asSet(e.writes)).toEqual(["narrative:*"]);
  });

  it("lets two UI writers opt out of the W/W false positive", () => {
    const first = deriveEffects(
      manifest({
        tools: { builtin: ["render-ui"] },
        effects: { parallelSafe: true },
      }),
    );
    const second = deriveEffects(
      manifest({
        tools: { builtin: ["render-ui"] },
        effects: { parallelSafe: true },
      }),
    );

    expect(effectsHazard(first, second)).toBe(false);
  });

  it("an explicit ui slot write hazards with a render-ui writer", () => {
    const slot = deriveEffects(
      manifest({ effects: { writes: ["ui:right"] } } as never),
    );
    const renderer = deriveEffects(
      manifest({ tools: { builtin: ["render-ui"] } }),
    );
    expect(effectsHazard(slot, renderer)).toBe(true);
  });

  it("derives an empty set for an agent with no declared surfaces (no unknown:* injected)", () => {
    const e = deriveEffects(manifest());
    expect(asSet(e.reads)).toEqual([]);
    expect(asSet(e.writes)).toEqual([]);
    expect(e.parallelSafe).toBe(false);
  });

  it("UNIONs an explicit effects declaration with the derivation (add/tighten, never remove)", () => {
    const e = deriveEffects(
      manifest({
        tools: { builtin: ["sync-characters"] },
        effects: {
          reads: ["lorebook:*"],
          writes: ["assets:*"],
          parallelSafe: true,
        },
      }),
    );
    // Derived characters:* is NOT removable; explicit assets:* is added.
    expect(asSet(e.writes)).toEqual(["assets:*", "characters:*"]);
    expect(asSet(e.reads)).toEqual(["characters:*", "lorebook:*"]);
    expect(e.parallelSafe).toBe(true);
  });
});

describe("resourcesIntersect — intersection rule", () => {
  const cases: Array<[EffectResource, EffectResource, boolean]> = [
    ["characters:*", "characters:*", true], // identical complete key
    ["state:*", "characters:*", false], // different namespaces
    ["plugin-data:self:inv", "plugin-data:self:inv", true], // identical
    ["plugin-data:self:inv", "plugin-data:self:quest", false], // different ns
    ["plugin-data:self:*", "plugin-data:self:inv", true], // namespace wildcard
    ["event:*", "event:scene.set", true], // event wildcard
    ["event:a", "event:b", false], // distinct topics
    ["unknown:*", "characters:*", true], // unknown intersects everything
    ["unknown:*", "plugin-data:self:x", true],
    ["state:*", "plugin-data:self:x", false], // no false wildcard over-match
  ];
  for (const [a, b, expected] of cases) {
    it(`${a} vs ${b} → ${expected}`, () => {
      expect(resourcesIntersect(a, b)).toBe(expected);
      expect(resourcesIntersect(b, a)).toBe(expected); // symmetric
    });
  }
});

describe("effectsHazard — matrix + parallelSafe exemption", () => {
  const eff = (
    reads: EffectResource[],
    writes: EffectResource[],
    parallelSafe = false,
  ): RuntimeEffects => ({
    reads: new Set(reads),
    writes: new Set(writes),
    parallelSafe,
  });

  it("R/R never hazards", () => {
    expect(effectsHazard(eff(["state:*"], []), eff(["state:*"], []))).toBe(
      false,
    );
  });

  it("W/W hazards", () => {
    expect(effectsHazard(eff([], ["state:*"]), eff([], ["state:*"]))).toBe(
      true,
    );
  });

  it("W/R hazards (A writes what B reads)", () => {
    expect(effectsHazard(eff([], ["state:*"]), eff(["state:*"], []))).toBe(
      true,
    );
  });

  it("R/W hazards (B writes what A reads)", () => {
    expect(
      effectsHazard(eff(["characters:*"], []), eff([], ["characters:*"])),
    ).toBe(true);
  });

  it("parallelSafe exempts pure W/W with no unknown:*", () => {
    expect(
      effectsHazard(eff([], ["state:*"], true), eff([], ["state:*"], true)),
    ).toBe(false);
  });

  it("parallelSafe does NOT exempt W/R even when both opt in", () => {
    expect(
      effectsHazard(eff([], ["state:*"], true), eff(["state:*"], [], true)),
    ).toBe(true);
  });

  it("parallelSafe does NOT exempt a W/W overlap that involves unknown:*", () => {
    expect(
      effectsHazard(eff([], ["unknown:*"], true), eff([], ["state:*"], true)),
    ).toBe(true);
  });

  it("only one side opting into parallelSafe is not enough", () => {
    expect(
      effectsHazard(eff([], ["state:*"], true), eff([], ["state:*"], false)),
    ).toBe(true);
  });
});

describe("applyHazardPolicy — stable warn / strict output", () => {
  // Two same-plugin runtimes that both write the character store (W/W hazard),
  // plus an independent narrator that only writes narrative (no conflict).
  const writerA = manifest({
    name: "p/a",
    tools: { builtin: ["sync-characters"] },
  });
  const writerB = manifest({
    name: "p/b",
    tools: { builtin: ["sync-characters"] },
  });
  const narrator = manifest({ name: "p/narrator", outputKind: "story" });
  const group: ScheduledGroup = {
    runtimes: [narrator, writerB, writerA], // deliberately unsorted
  };

  it("warn: emits one stable diagnostic per hazard pair, keeps the group parallel", () => {
    const first = applyHazardPolicy([group], "warn");
    const second = applyHazardPolicy([group], "warn");

    // Group is unchanged (still one parallel level of three).
    expect(first.groups).toHaveLength(1);
    expect(first.groups[0]?.runtimes).toHaveLength(3);

    // Exactly the a↔b pair hazards; narrator is independent.
    expect(first.diagnostics).toHaveLength(1);
    expect(first.diagnostics[0]?.code).toBe("effects-hazard");
    expect(first.diagnostics[0]?.message).toContain("p/a");
    expect(first.diagnostics[0]?.message).toContain("p/b");
    expect(first.diagnostics[0]?.message).toContain("warn");

    // Deterministic: same input → byte-identical diagnostics.
    expect(second.diagnostics).toEqual(first.diagnostics);
  });

  it("strict: splits the conflicting pair into ordered serial sub-levels, deterministically", () => {
    const first = applyHazardPolicy([group], "strict");
    const second = applyHazardPolicy([group], "strict");

    // a and b must not share a level; narrator stays parallel with the first.
    const levels = first.groups.map((g) =>
      g.runtimes.map((r) => r.name).sort(),
    );
    expect(levels).toEqual([
      ["p/a", "p/narrator"], // level 0: writerA + independent narrator
      ["p/b"], // level 1: writerB serialized after writerA
    ]);
    // Serialized in stable id order (a before b).
    expect(first.diagnostics).toHaveLength(1);
    // Deterministic re-layering.
    expect(second.groups.map((g) => g.runtimes.map((r) => r.name))).toEqual(
      first.groups.map((g) => g.runtimes.map((r) => r.name)),
    );
  });

  it("single-runtime and hazard-free groups pass through untouched", () => {
    const solo: ScheduledGroup = { runtimes: [writerA] };
    const clean: ScheduledGroup = {
      runtimes: [narrator, writerA],
    };
    const out = applyHazardPolicy([solo, clean], "strict");
    expect(out.diagnostics).toHaveLength(0);
    expect(out.groups).toHaveLength(2);
    expect(out.groups[1]?.runtimes).toHaveLength(2);
  });
});
