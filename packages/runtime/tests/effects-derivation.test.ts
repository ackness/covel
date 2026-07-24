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
    pluginType: "community",
    priority: 500,
    trigger: { type: "auto" },
    model: "gpt-4o-mini",
    runtimeType: "agent",
    ...overrides,
  } as RuntimeManifest;
}

const asSet = (r: ReadonlySet<EffectResource>) => [...r].sort();

describe("deriveEffects — builtin tool mapping table", () => {
  it("maps character tools to characters:* (write for create/update, read for get/list)", () => {
    const w = deriveEffects(
      manifest({
        tools: { builtin: ["create-character", "update-character"] },
      }),
    );
    expect(asSet(w.writes)).toEqual(["characters:*"]);
    expect(asSet(w.reads)).toEqual([]);

    const r = deriveEffects(
      manifest({ tools: { builtin: ["get-character", "list-characters"] } }),
    );
    expect(asSet(r.reads)).toEqual(["characters:*"]);
    expect(asSet(r.writes)).toEqual([]);
  });

  it("maps memory-update-block to working-memory:* write", () => {
    const e = deriveEffects(
      manifest({ tools: { builtin: ["memory-update-block"] } }),
    );
    expect(asSet(e.writes)).toEqual(["working-memory:*"]);
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

  it("maps world-dimension-get to a state:* read", () => {
    const e = deriveEffects(
      manifest({ tools: { builtin: ["world-dimension-get"] } }),
    );
    expect(asSet(e.reads)).toEqual(["state:*"]);
  });

  it("maps plugin-data-set to per-namespace self keys when dataSchemas are declared", () => {
    const e = deriveEffects(
      manifest({
        tools: { builtin: ["plugin-data-set", "plugin-data-set-batch"] },
        dataSchemas: {
          inventory: {
            schemaVersion: 1,
            acceptsWorldData: false,
            schema: "./s.json",
          },
          quests: {
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

  it("maps emit-event to one event key per declared topic; event:* when none declared", () => {
    const withTopics = deriveEffects(
      manifest({
        tools: { builtin: ["emit-event"] },
        events: [
          {
            topic: "scene.set",
            schema: "./a.json",
            description: "",
            advertise: true,
          },
          {
            topic: "dice.rolled",
            schema: "./b.json",
            description: "",
            advertise: true,
          },
        ],
      }),
    );
    expect(asSet(withTopics.writes)).toEqual([
      "event:dice.rolled",
      "event:scene.set",
    ]);

    const noTopics = deriveEffects(
      manifest({ tools: { builtin: ["emit-event"] } }),
    );
    expect(asSet(noTopics.writes)).toEqual(["event:*"]);
  });

  it("derives narrative:* from outputKind story and ui:* from a declared ui block", () => {
    const e = deriveEffects(
      manifest({ outputKind: "story", ui: { right: "./ui.json" } as never }),
    );
    expect(asSet(e.writes)).toEqual(["narrative:*", "ui:*"]);
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
        tools: { builtin: ["create-character"] },
        effects: {
          reads: ["lorebook:*"],
          writes: ["assets:*"],
          parallelSafe: true,
        },
      }),
    );
    // Derived characters:* is NOT removable; explicit assets:* is added.
    expect(asSet(e.writes)).toEqual(["assets:*", "characters:*"]);
    expect(asSet(e.reads)).toEqual(["lorebook:*"]);
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
    tools: { builtin: ["update-character"] },
  });
  const writerB = manifest({
    name: "p/b",
    tools: { builtin: ["create-character"] },
  });
  const narrator = manifest({ name: "p/narrator", outputKind: "story" });
  const group: ScheduledGroup = {
    priority: 500,
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
    const solo: ScheduledGroup = { priority: 500, runtimes: [writerA] };
    const clean: ScheduledGroup = {
      priority: 500,
      runtimes: [narrator, writerA],
    };
    const out = applyHazardPolicy([solo, clean], "strict");
    expect(out.diagnostics).toHaveLength(0);
    expect(out.groups).toHaveLength(2);
    expect(out.groups[1]?.runtimes).toHaveLength(2);
  });
});
