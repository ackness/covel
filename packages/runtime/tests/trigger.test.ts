import { describe, it, expect } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import type { TriggerContext } from "../src/types.js";
import { shouldTrigger } from "../src/trigger/trigger.js";

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "test-rt",
    pluginId: "test-rt",
    description: "test",
    priority: 500,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<TriggerContext>): TriggerContext {
  const merged: TriggerContext = {
    sessionId: "sess-1",
    turnNumber: 5,
    logicalTurn: 5,
    triggerCount: 0,
    turnsSinceLastTrigger: 999,
    pendingEventTopics: [],
    isManualTrigger: false,
    preGameCompleted: [],
    ...overrides,
  };
  // scheduled / startTurn gate on `logicalTurn`; these cases express the turn
  // number via `turnNumber`, so mirror it unless a test sets logicalTurn.
  return {
    ...merged,
    logicalTurn: overrides?.logicalTurn ?? merged.turnNumber,
  };
}

describe("shouldTrigger", () => {
  // 1. auto (default) — no trigger config → true
  it("should return true when no trigger config (defaults to auto)", () => {
    const manifest = makeManifest();
    const ctx = makeContext();
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 2. auto explicit — trigger.type: 'auto' → true
  it("should return true for explicit auto trigger type", () => {
    const manifest = makeManifest({ trigger: { type: "auto" } });
    const ctx = makeContext();
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 3. manual, not triggered
  it("should return false for manual trigger when isManualTrigger is false", () => {
    const manifest = makeManifest({ trigger: { type: "manual" } });
    const ctx = makeContext({ isManualTrigger: false });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 4. manual, triggered
  it("should return true for manual trigger when isManualTrigger is true", () => {
    const manifest = makeManifest({ trigger: { type: "manual" } });
    const ctx = makeContext({ isManualTrigger: true });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 5. scheduled, on interval
  it("should return true for scheduled trigger when turnNumber is on interval", () => {
    const manifest = makeManifest({
      trigger: { type: "scheduled", interval: 3 },
    });
    const ctx = makeContext({ turnNumber: 6 });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 6. scheduled, off interval
  it("should return false for scheduled trigger when turnNumber is off interval", () => {
    const manifest = makeManifest({
      trigger: { type: "scheduled", interval: 3 },
    });
    const ctx = makeContext({ turnNumber: 7 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 7. event, matching topic
  it("should return true for event trigger when topic matches pending events", () => {
    const manifest = makeManifest({
      trigger: { type: "event", topic: "quest.completed" },
    });
    const ctx = makeContext({ pendingEventTopics: ["quest.completed"] });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  // 8. event, no match
  it("should return false for event trigger when topic does not match", () => {
    const manifest = makeManifest({
      trigger: { type: "event", topic: "quest.completed" },
    });
    const ctx = makeContext({ pendingEventTopics: ["combat.start"] });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 9. error-retry is reserved and never fires
  it("should return false for reserved error-retry trigger", () => {
    const manifest = makeManifest({ trigger: { type: "error-retry" } });
    expect(shouldTrigger(manifest, makeContext())).toBe(false);
  });

  // 11. conditional with unknown condition returns false
  it("should return false for conditional trigger with unknown condition", () => {
    const manifest = makeManifest({
      trigger: { type: "conditional", condition: "has-write-conflicts" },
    });
    const ctx = makeContext();
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 12. maxTriggerCount exceeded
  it("should return false when triggerCount >= maxTriggerCount", () => {
    const manifest = makeManifest({
      trigger: { type: "auto", maxTriggerCount: 3 },
    });
    const ctx = makeContext({ triggerCount: 3 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // 13. cooldownTurns not met
  it("should return false when turnsSinceLastTrigger < cooldownTurns", () => {
    const manifest = makeManifest({
      trigger: { type: "auto", cooldownTurns: 5 },
    });
    const ctx = makeContext({ turnsSinceLastTrigger: 2 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  // ── startTurn is compared against turnNumber directly

  it("should gate by turnNumber when startTurn is set", () => {
    const manifest = makeManifest({
      trigger: { type: "auto", startTurn: 3 },
    });
    const ctx = makeContext({ turnNumber: 2 });
    expect(shouldTrigger(manifest, ctx)).toBe(false);
  });

  it("should trigger once turnNumber reaches startTurn", () => {
    const manifest = makeManifest({
      trigger: { type: "auto", startTurn: 3 },
    });
    const ctx = makeContext({ turnNumber: 3 });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });

  it("should not gate when startTurn is undefined", () => {
    const manifest = makeManifest({ trigger: { type: "auto" } });
    const ctx = makeContext({ turnNumber: 0 });
    expect(shouldTrigger(manifest, ctx)).toBe(true);
  });
});

describe("shouldTrigger — preGameCompleted gate", () => {
  it("skips runtime whose name is in preGameCompleted", () => {
    const rt = {
      name: "pregame",
      pluginId: "pregame",
      description: "pre-game",
      priority: 10,
      trigger: { type: "auto" },
    } as RuntimeManifest;
    const ctx: TriggerContext = {
      sessionId: "sess-1",
      turnNumber: 0,
      triggerCount: 0,
      turnsSinceLastTrigger: 999,
      pendingEventTopics: [],
      isManualTrigger: false,
      preGameCompleted: ["pregame"],
    };
    expect(shouldTrigger(rt, ctx)).toBe(false);
  });

  it("passes runtime whose name is NOT in preGameCompleted", () => {
    const rt = {
      name: "pregame",
      pluginId: "pregame",
      description: "pre-game",
      priority: 10,
      trigger: { type: "auto" },
    } as RuntimeManifest;
    const ctx: TriggerContext = {
      sessionId: "sess-1",
      turnNumber: 0,
      triggerCount: 0,
      turnsSinceLastTrigger: 999,
      pendingEventTopics: [],
      isManualTrigger: false,
      preGameCompleted: [],
    };
    expect(shouldTrigger(rt, ctx)).toBe(true);
  });

  it("does not affect runtimes not in the preGameCompleted list", () => {
    const rt = {
      name: "narrator",
      pluginId: "narrator",
      description: "narrator",
      priority: 500,
      trigger: { type: "auto" },
    } as RuntimeManifest;
    const ctx: TriggerContext = {
      sessionId: "sess-1",
      turnNumber: 5,
      triggerCount: 0,
      turnsSinceLastTrigger: 999,
      pendingEventTopics: [],
      isManualTrigger: false,
      preGameCompleted: ["pregame", "world-init/schema-gen"],
    };
    expect(shouldTrigger(rt, ctx)).toBe(true);
  });
});
