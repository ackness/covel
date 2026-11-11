import { describe, it, expect } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import type { TriggerContext } from "../src/types.js";
import { shouldTrigger } from "../src/trigger/trigger.js";

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "test-rt",
    pluginId: "test-rt",
    description: "test",
    stage: "narrative",
    ...overrides,
  };
}

function makeContext(overrides?: Partial<TriggerContext>): TriggerContext {
  return {
    sessionId: "sess-1",
    // Keep the message count distinct so cadence cannot accidentally use it.
    turnNumber: 99,
    logicalTurn: 5,
    triggerCount: 0,
    turnsSinceLastTrigger: 999,
    pendingEventTopics: [],
    ...overrides,
  };
}

describe("shouldTrigger", () => {
  it("defaults to auto when trigger configuration is absent", () => {
    expect(shouldTrigger(makeManifest(), makeContext())).toBe(true);
  });

  it("defaults an explicit auto trigger to every logical turn", () => {
    const manifest = makeManifest({ trigger: { type: "auto" } });
    expect(shouldTrigger(manifest, makeContext())).toBe(true);
  });

  it("leaves explicit manual selection to the scheduler", () => {
    const manifest = makeManifest({ trigger: { type: "manual" } });
    expect(shouldTrigger(manifest, makeContext())).toBe(false);
  });

  it.each([
    [6, true],
    [7, false],
  ] as const)(
    "evaluates auto cadence on logical turn %i",
    (logicalTurn, expected) => {
      const manifest = makeManifest({ trigger: { type: "auto", every: 3 } });
      expect(shouldTrigger(manifest, makeContext({ logicalTurn }))).toBe(
        expected,
      );
    },
  );

  it.each([
    ["quest.completed", true],
    ["combat.start", false],
    [undefined, false],
  ] as const)("requires a matching event topic (%s)", (topic, expected) => {
    const manifest = makeManifest({ trigger: { type: "event", topic } });
    const context = makeContext({ pendingEventTopics: ["quest.completed"] });
    expect(shouldTrigger(manifest, context)).toBe(expected);
  });

  it("rejects a trigger type outside the current contract", () => {
    const manifest = makeManifest({
      trigger: { type: "unsupported" },
    } as unknown as Partial<RuntimeManifest>);
    expect(shouldTrigger(manifest, makeContext())).toBe(false);
  });

  it.each(["auto", "event"] as const)(
    "enforces maxTriggerCount for %s runtimes",
    (type) => {
      const manifest = makeManifest({
        trigger: { type, topic: "quest.completed", maxTriggerCount: 3 },
      });
      const context = makeContext({
        triggerCount: 3,
        pendingEventTopics: ["quest.completed"],
      });
      expect(shouldTrigger(manifest, context)).toBe(false);
    },
  );

  it("blocks automatic execution during cooldown", () => {
    const manifest = makeManifest({
      trigger: { type: "auto", cooldownTurns: 5 },
    });
    expect(
      shouldTrigger(manifest, makeContext({ turnsSinceLastTrigger: 2 })),
    ).toBe(false);
  });

  it.each([
    [2, false],
    [3, true],
  ] as const)(
    "checks startTurn against logical turn %i",
    (logicalTurn, expected) => {
      const manifest = makeManifest({
        trigger: { type: "auto", startTurn: 3 },
      });
      expect(shouldTrigger(manifest, makeContext({ logicalTurn }))).toBe(
        expected,
      );
    },
  );

  it("requires both startTurn and cadence to pass", () => {
    const manifest = makeManifest({
      trigger: { type: "auto", every: 2, startTurn: 4 },
    });
    for (const [logicalTurn, expected] of [
      [2, false],
      [4, true],
      [5, false],
      [6, true],
    ] as const) {
      expect(shouldTrigger(manifest, makeContext({ logicalTurn }))).toBe(
        expected,
      );
    }
  });
});
