/**
 * CovelEvent contract (S/T7) — locks the single-source-of-truth event union.
 *
 * The `/api/actions` forwarding whitelist used to be a hand-written `Set` in
 * actions.ts that drifted from `ProtocolEventType` (e.g. `runtime.skipped` was
 * emitted but absent from the union). These tests assert that the server's
 * forwarding whitelist is DERIVED from `COVEL_EVENT_META` and that the known
 * drift cases are now fixed inside the union itself.
 */

import { describe, it, expect } from "vitest";
import {
  COVEL_EVENT_META,
  FORWARDED_EVENT_TYPES,
  SUBSCRIPTION_TOPICS,
} from "@covel/shared";
import type { CovelEventType } from "@covel/shared";
import { buildFrameworkCapabilities } from "../../src/routes/api/discovery.js";

describe("CovelEvent contract", () => {
  it("server forwarding whitelist equals the set flagged forwardToActionStream", () => {
    const flagged = Object.entries(COVEL_EVENT_META)
      .filter(([, meta]) => meta.forwardToActionStream)
      .map(([type]) => type)
      .sort();
    // FORWARDED_EVENT_TYPES is exactly what actions.ts imports and uses.
    expect([...FORWARDED_EVENT_TYPES].sort()).toEqual(flagged);
  });

  it("forwarding whitelist matches the documented forwarded set (regression lock)", () => {
    // Mirrors the previous hand-written FORWARDED_SUBTYPES in actions.ts — any
    // accidental meta flag flip is caught here.
    const expected = [
      "asset.progress",
      "block.emitted",
      "character.upserted",
      "gateway.calling",
      "gateway.failed",
      "gateway.responded",
      "hook.aborted",
      "hook.fired",
      "hook.rewrote",
      "llm.calling",
      "llm.responded",
      "message.completed",
      "plugin-data.changed",
      "state.patch.applied",
      "tool.calling",
      "tool.completed",
      "tool.failed",
      "turn.resumed",
      "turn.suspended",
      "ui.rendered",
      "world.dimensions.changed",
    ];
    expect([...FORWARDED_EVENT_TYPES].sort()).toEqual(expected);
  });

  it("function.* trace events are union members, trace-only (not forwarded)", () => {
    const executing: CovelEventType = "function.executing";
    const completed: CovelEventType = "function.completed";
    for (const t of [executing, completed]) {
      expect(COVEL_EVENT_META[t].forwardToActionStream).toBe(false);
      expect(FORWARDED_EVENT_TYPES.has(t)).toBe(false);
    }
  });

  it("gateway.* trace events are union members forwarded for llm.* parity", () => {
    const calling: CovelEventType = "gateway.calling";
    const responded: CovelEventType = "gateway.responded";
    const failed: CovelEventType = "gateway.failed";
    for (const t of [calling, responded, failed]) {
      expect(COVEL_EVENT_META[t].forwardToActionStream).toBe(true);
      expect(FORWARDED_EVENT_TYPES.has(t)).toBe(true);
    }
  });

  it("utils.fetch.* trace events are union members, trace-only (not forwarded)", () => {
    const calling: CovelEventType = "utils.fetch.calling";
    const responded: CovelEventType = "utils.fetch.responded";
    const failed: CovelEventType = "utils.fetch.failed";
    for (const t of [calling, responded, failed]) {
      expect(COVEL_EVENT_META[t].forwardToActionStream).toBe(false);
      expect(FORWARDED_EVENT_TYPES.has(t)).toBe(false);
    }
  });

  it("runtime.skipped is a member of the CovelEvent union (drift fix)", () => {
    const skipped: CovelEventType = "runtime.skipped";
    expect(COVEL_EVENT_META[skipped]).toBeDefined();
    // Skipped is emitted directly on the action stream, not forwarded.
    expect(COVEL_EVENT_META[skipped].forwardToActionStream).toBe(false);
  });

  it("event-meta keys are unique and non-empty", () => {
    // `satisfies Record<CovelEventType, CovelEventMeta>` enforces exhaustive,
    // exact key coverage at compile time; assert basic sanity at runtime.
    const keys = Object.keys(COVEL_EVENT_META);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("discovery advertised protocol.events equal the CovelEvent union (M1 drift lock)", () => {
    // discovery.ts used to hand-maintain a parallel PROTOCOL_EVENT_TYPES array
    // that drifted from the union (missing tool.*/llm.*/hook.* etc.). It now
    // derives `protocol.events` from COVEL_EVENT_META; this locks the equality
    // so the discovery advertisement can never lie to clients again.
    const framework = buildFrameworkCapabilities().framework as {
      protocol: { events: readonly string[] };
    };
    const advertised = [...framework.protocol.events].sort();
    const union = Object.keys(COVEL_EVENT_META).sort();
    expect(advertised).toEqual(union);
  });

  it("working_memory.changed is a CovelEvent union member (H1 drift fix)", () => {
    // Emitted as a commit event and written straight onto the action stream;
    // was previously absent from the union → hit the frontend assertNeverEvent
    // guard on every working_memory.set commit.
    const wm: CovelEventType = "working_memory.changed";
    expect(COVEL_EVENT_META[wm]).toBeDefined();
    // Commit-direct delivery, not eventBus-forwarded → stays out of the
    // forwarding whitelist.
    expect(COVEL_EVENT_META[wm].forwardToActionStream).toBe(false);
    expect(FORWARDED_EVENT_TYPES.has(wm)).toBe(false);
  });

  it("trace and hooks are subscribable topics (drift fix)", () => {
    // TurnEmitter emits `_subTopic: "trace"`, the hook pipeline `"hooks"`.
    // Both must be valid SubscriptionTopics so /events/stream accepts them.
    expect(SUBSCRIPTION_TOPICS).toContain("trace");
    expect(SUBSCRIPTION_TOPICS).toContain("hooks");
  });
});
