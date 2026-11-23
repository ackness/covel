import { describe, expect, it } from "vitest";
import type { PromptSegment, RuntimeManifest } from "@covel/shared";
import {
  evaluatePromptWhen,
  governPromptSegments,
  selectPromptSegments,
  truncateContentToBudget,
} from "../src/extension-segments.js";

function makeManifest(
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    pluginId: "narrator-plugin",
    name: "narrator",
    runtimeType: "agent",
    outputKind: "story",
    ...overrides,
  } as RuntimeManifest;
}

function seg(overrides: Partial<PromptSegment> = {}): PromptSegment {
  return {
    id: "seg-1",
    position: "system",
    providerPluginId: "provider-a",
    volatility: "session",
    audience: "all",
    content: "Default content",
    ...overrides,
  };
}

describe("Prompt Governance Engine", () => {
  describe("evaluatePromptWhen", () => {
    it("evaluates exists, equals, notEquals, in, and all/any clauses", () => {
      const facts = { phase: "combat", turn: 3, flagged: true };
      expect(evaluatePromptWhen(undefined, facts)).toBe(true);
      expect(
        evaluatePromptWhen({ fact: "phase", equals: "combat" }, facts),
      ).toBe(true);
      expect(
        evaluatePromptWhen({ fact: "phase", notEquals: "social" }, facts),
      ).toBe(true);
      expect(
        evaluatePromptWhen({ fact: "missing", exists: false }, facts),
      ).toBe(true);
      expect(evaluatePromptWhen({ fact: "missing", exists: true }, facts)).toBe(
        false,
      );
      expect(evaluatePromptWhen({ fact: "turn", in: [1, 3, 5] }, facts)).toBe(
        true,
      );
      expect(
        evaluatePromptWhen(
          {
            all: [
              { fact: "flagged", equals: true },
              { fact: "phase", equals: "combat" },
            ],
          },
          facts,
        ),
      ).toBe(true);
      expect(
        evaluatePromptWhen(
          {
            any: [
              { fact: "phase", equals: "social" },
              { fact: "phase", equals: "combat" },
            ],
          },
          facts,
        ),
      ).toBe(true);
    });
  });

  describe("truncateContentToBudget", () => {
    it("preserves surrogate pairs and respects exact token caps", () => {
      const emojis = "🗡️🛡️🧙‍♂️".repeat(20);
      const estimator = (text: string) => Math.ceil(text.length / 4);
      const res = truncateContentToBudget(emojis, 12, estimator);
      expect(res.truncated).toBe(true);
      expect(res.finalTokens).toBeLessThanOrEqual(12);
      // Verify no lone surrogate at truncation cut before suffix
      expect(() => encodeURIComponent(res.content)).not.toThrow();

      expect(truncateContentToBudget("short", 10, estimator)).toEqual({
        content: "short",
        truncated: false,
        originalTokens: 2,
        finalTokens: 2,
      });

      expect(truncateContentToBudget("short", 0, estimator)).toEqual({
        content: "",
        truncated: true,
        originalTokens: 2,
        finalTokens: 0,
      });
    });
  });

  describe("governPromptSegments", () => {
    it("orders by volatility -> order -> providerPluginId -> id", () => {
      const result = governPromptSegments(
        [
          seg({ id: "t-1", volatility: "turn", order: 1 }),
          seg({
            id: "s-2",
            volatility: "session",
            order: 20,
            providerPluginId: "b",
          }),
          seg({
            id: "s-1",
            volatility: "session",
            order: 5,
            providerPluginId: "c",
          }),
          seg({ id: "st-1", volatility: "stable", order: 99 }),
        ],
        makeManifest(),
      );
      expect(result.segments.map((s) => s.id)).toEqual([
        "st-1",
        "s-1",
        "s-2",
        "t-1",
      ]);
      expect(
        selectPromptSegments(result.segments, makeManifest()).map((s) => s.id),
      ).toEqual(["st-1", "s-1", "s-2", "t-1"]);
    });

    it("propagates cross-plugin Facts across rounds before audience & when gating", () => {
      const result = governPromptSegments(
        [
          seg({
            id: "consumer",
            providerPluginId: "plugin-c",
            when: { fact: "combatActive", equals: true },
            facts: { threatLevel: "high" },
            content: "Combat rules enabled",
          }),
          seg({
            id: "producer",
            providerPluginId: "plugin-p",
            facts: { combatActive: true },
            content: "Combat tracker",
          }),
          seg({
            id: "second-hop",
            providerPluginId: "plugin-s",
            audience: "story",
            when: { fact: "threatLevel", equals: "high" },
            content: "High threat guidance",
          }),
          seg({
            id: "self-only",
            providerPluginId: "other-plugin",
            audience: "self",
            content: "Hidden from narrator-plugin",
          }),
        ],
        makeManifest({ outputKind: "story" }),
      );

      expect(result.facts).toEqual({
        combatActive: true,
        threatLevel: "high",
      });
      expect(result.segments.map((s) => s.id)).toEqual([
        "consumer",
        "producer",
        "second-hop",
      ]);
    });

    it("enforces suppresses on suppressible blocks and non-protected segments while guarding protected ones", () => {
      const result = governPromptSegments(
        [
          seg({
            id: "suppressor",
            providerPluginId: "override-mod",
            suppresses: [
              "world.info.before",
              "framework.preamble",
              "weak-seg",
              "plugin-x/locked-seg",
            ],
            content: "Custom replacement lore",
          }),
          seg({
            id: "weak-seg",
            providerPluginId: "plugin-w",
            content: "Will be suppressed",
          }),
          seg({
            id: "locked-seg",
            providerPluginId: "plugin-x",
            protected: true,
            content: "Protected segment stays",
          }),
        ],
        makeManifest(),
      );

      expect(result.suppressedBlocks).toEqual(new Set(["world.info.before"]));
      expect(result.segments.map((s) => s.id)).toEqual([
        "suppressor",
        "locked-seg",
      ]);
      expect(result.diagnostics).toEqual([
        {
          kind: "protected-suppress-ignored",
          pluginId: "override-mod",
          segmentId: "suppressor",
          targetId: "framework.preamble",
        },
        {
          kind: "protected-suppress-ignored",
          pluginId: "override-mod",
          segmentId: "suppressor",
          targetId: "plugin-x/locked-seg",
        },
      ]);
    });

    it("enforces hard per-segment token budgets and emits truncated diagnostics", () => {
      const result = governPromptSegments(
        [
          seg({
            id: "over-budget",
            providerPluginId: "verbose-plugin",
            budget: 5,
            content: "word ".repeat(30),
          }),
        ],
        makeManifest(),
        { estimator: (text) => text.length },
      );

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]!.content.length).toBeLessThanOrEqual(5);
      expect(result.diagnostics).toEqual([
        {
          kind: "truncated",
          pluginId: "verbose-plugin",
          segmentId: "over-budget",
          budget: 5,
          originalTokens: 150,
          finalTokens: expect.any(Number),
        },
      ]);
    });
  });
});
