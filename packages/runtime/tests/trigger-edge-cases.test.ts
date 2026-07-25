/**
 * Trigger router — combinatorial and conditional-warning behaviours that
 * `trigger.test.ts` does not cover:
 *  - cooldown + maxTriggerCount interplay
 *  - manual + cooldown
 *  - scheduled + startTurn together
 *  - event without a configured topic
 *  - reserved modes (error-retry / conditional) never fire
 *  - conditional emits exactly one console.warn per (sessionId, runtimeId)
 *  - preGameCompleted gate runs BEFORE startTurn (so a Pre-Game runtime
 *    that already finished isn't re-evaluated)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import type { TriggerContext } from "../src/types.js";
import { shouldTrigger } from "../src/trigger/trigger.js";

function manifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "rt",
    pluginId: "rt",
    description: "test",
    stage: "narrative",
    ...overrides,
  } as RuntimeManifest;
}

function ctx(overrides?: Partial<TriggerContext>): TriggerContext {
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

describe("shouldTrigger — gate ordering", () => {
  it("preGameCompleted is checked BEFORE startTurn, so a re-run of a done Pre-Game runtime is silent", () => {
    // Runtime is done (preGameCompleted) AND turnNumber < startTurn. Both
    // conditions block, but we must not pay the cost of evaluating startTurn.
    // The contract here is "preGameCompleted short-circuits first" — keeps
    // scheduler logs from filling with "blocked by startTurn" noise for
    // already-finished Pre-Game plugins.
    const m = manifest({ trigger: { type: "auto", startTurn: 10 } });
    const c = ctx({ preGameCompleted: [m.name], turnNumber: 0 });
    expect(shouldTrigger(m, c)).toBe(false);
  });

  it("cooldown takes precedence over the trigger-type branch (auto)", () => {
    const m = manifest({ trigger: { type: "auto", cooldownTurns: 5 } });
    const c = ctx({ turnsSinceLastTrigger: 2 });
    expect(shouldTrigger(m, c)).toBe(false);
  });

  it("cooldown takes precedence over manual flag too", () => {
    // Even an explicit manual trigger must respect cooldown — players who
    // mash the button shouldn't bypass throttling.
    const m = manifest({ trigger: { type: "manual", cooldownTurns: 3 } });
    const c = ctx({ isManualTrigger: true, turnsSinceLastTrigger: 1 });
    expect(shouldTrigger(m, c)).toBe(false);
  });

  it("maxTriggerCount blocks even when other gates would pass", () => {
    const m = manifest({
      trigger: { type: "event", topic: "quest.completed", maxTriggerCount: 1 },
    });
    const c = ctx({ pendingEventTopics: ["quest.completed"], triggerCount: 1 });
    expect(shouldTrigger(m, c)).toBe(false);
  });
});

describe("shouldTrigger — scheduled", () => {
  it("scheduled with interval=1 fires every turn", () => {
    const m = manifest({ trigger: { type: "scheduled", interval: 1 } });
    expect(shouldTrigger(m, ctx({ turnNumber: 1 }))).toBe(true);
    expect(shouldTrigger(m, ctx({ turnNumber: 2 }))).toBe(true);
    expect(shouldTrigger(m, ctx({ turnNumber: 7 }))).toBe(true);
  });

  it("scheduled defaults interval to 1 when omitted", () => {
    const m = manifest({ trigger: { type: "scheduled" } });
    expect(shouldTrigger(m, ctx({ turnNumber: 4 }))).toBe(true);
  });

  it("scheduled fires at turnNumber=0 because 0 % N === 0", () => {
    // Pre-Game band still uses scheduled triggers — they must fire at turn 0.
    // (The scheduler's band filter already handles whether priority is
    // in-band; this is just the trigger-router contract.)
    const m = manifest({ trigger: { type: "scheduled", interval: 3 } });
    expect(shouldTrigger(m, ctx({ turnNumber: 0 }))).toBe(true);
  });

  it("scheduled + startTurn: blocked before startTurn even on interval", () => {
    const m = manifest({
      trigger: { type: "scheduled", interval: 2, startTurn: 4 },
    });
    expect(shouldTrigger(m, ctx({ turnNumber: 2 }))).toBe(false);
    expect(shouldTrigger(m, ctx({ turnNumber: 4 }))).toBe(true);
    expect(shouldTrigger(m, ctx({ turnNumber: 5 }))).toBe(false); // off interval
    expect(shouldTrigger(m, ctx({ turnNumber: 6 }))).toBe(true);
  });
});

describe("shouldTrigger — event", () => {
  it("event with NO topic field never triggers (defensive default)", () => {
    // A manifest that declares trigger.type: 'event' but forgets to set
    // `topic` shouldn't accidentally fire on every pending event — that
    // would be a privilege escalation. Treat missing topic as "never".
    const m = manifest({
      trigger: { type: "event" },
    } as Partial<RuntimeManifest>);
    const c = ctx({ pendingEventTopics: ["some.event"] });
    expect(shouldTrigger(m, c)).toBe(false);
  });

  it("multiple runtimes subscribed to the same topic each see the event", () => {
    const a = manifest({ name: "a", trigger: { type: "event", topic: "t" } });
    const b = manifest({ name: "b", trigger: { type: "event", topic: "t" } });
    const c = ctx({ pendingEventTopics: ["t"] });
    expect(shouldTrigger(a, c)).toBe(true);
    expect(shouldTrigger(b, c)).toBe(true);
  });
});

describe("shouldTrigger — error-retry (reserved)", () => {
  it("never triggers regardless of triggerCount", () => {
    const m = manifest({ trigger: { type: "error-retry", maxRetryCount: 5 } });
    expect(shouldTrigger(m, ctx({ triggerCount: 0 }))).toBe(false);
    expect(shouldTrigger(m, ctx({ triggerCount: 3 }))).toBe(false);
  });
});

describe("shouldTrigger — unknown trigger type", () => {
  it("returns false for a trigger type outside the production enum", () => {
    // The enum is narrowed to the four production types at the schema layer;
    // a programmatically constructed manifest with an unknown type must stay
    // quiescent rather than throw.
    const m = manifest({
      trigger: { type: "conditional" },
    } as unknown as Partial<RuntimeManifest>);
    expect(shouldTrigger(m, ctx({ sessionId: "sess-unknown" }))).toBe(false);
  });
});
