/**
 * Proposal-source invariants — every proposal produced by `normalizeOutput`
 * for a single runtime must carry:
 *  - the EXACT same `source` reference content
 *  - the EXACT same `turnId`
 *  - the EXACT same `sessionId`
 *  - a UNIQUE `id` (no collisions even when two proposals carry identical payload)
 *  - a non-empty ISO timestamp
 *
 * These are the contract the commit pipeline + trace consumers depend on.
 * A regression here silently breaks debug-page cross-linking and SSE
 * routing, so we lock them down separately from the per-type tests in
 * `session-kernel.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { normalizeOutput } from "../src/session/session-kernel.js";

const SOURCE = { pluginId: "codex", runtimeId: "codex/unlocker" };
const TURN_ID = "turn-X-001";
const SESSION_ID = "sess-X-001";

describe("proposal source invariants", () => {
  it("all proposals from one normalize call share source / turnId / sessionId", () => {
    const output = {
      narrativeOutput: "Story line.",
      events: [
        { topic: "quest.complete", data: { id: "q1" } },
        { topic: "quest.start", data: { id: "q2" } },
      ],
      statePatches: [{ table: "world", field: "time", value: "night" }],
      pluginData: [
        { namespace: "entries", key: "k1", value: 1 },
        { namespace: "entries", key: "k2", value: 2 },
      ],
    };

    const proposals = normalizeOutput(
      output,
      SOURCE,
      TURN_ID,
      SESSION_ID,
      "story",
    );

    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p.source).toEqual(SOURCE);
      expect(p.turnId).toBe(TURN_ID);
      expect(p.sessionId).toBe(SESSION_ID);
    }
  });

  it("does not mutate the source object passed in", () => {
    const sourceArg = { pluginId: "p", runtimeId: "r" };
    const snapshot = { ...sourceArg };
    normalizeOutput(
      { events: [{ topic: "t", data: {} }] },
      sourceArg,
      TURN_ID,
      SESSION_ID,
    );
    expect(sourceArg).toEqual(snapshot);
  });

  it("proposal IDs are unique across the batch even when payloads are identical", () => {
    // Two notifications with the exact same content must still get distinct
    // proposal IDs — otherwise SSE consumers dedupe and the player only
    // sees one banner.
    const output = {
      notifications: [
        { level: "info", title: "T", message: "M" },
        { level: "info", title: "T", message: "M" },
      ],
    };
    const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);
    const ids = proposals.map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // Both proposals fully identical except `id` and `timestamp`.
    expect(proposals[0].payload).toEqual(proposals[1].payload);
  });

  it("every proposal has a parsable ISO timestamp", () => {
    const output = {
      narrativeOutput: "x",
      events: [{ topic: "t", data: {} }],
    };
    const proposals = normalizeOutput(
      output,
      SOURCE,
      TURN_ID,
      SESSION_ID,
      "story",
    );

    for (const p of proposals) {
      expect(typeof p.timestamp).toBe("string");
      expect(p.timestamp.length).toBeGreaterThan(0);
      const parsed = Date.parse(p.timestamp);
      expect(Number.isNaN(parsed)).toBe(false);
    }
  });

  it("outputKind=plugin still tags non-narrative proposals with the same source", () => {
    // Regression guard: when the narrative.append is suppressed for non-story
    // runtimes, the OTHER proposals must still carry the original source.
    const output = {
      narrativeOutput: "Suppressed prose.",
      events: [{ topic: "plugin.tick", data: {} }],
    };
    const proposals = normalizeOutput(
      output,
      SOURCE,
      TURN_ID,
      SESSION_ID,
      "plugin",
    );
    // No narrative proposal allowed for plugin kind.
    expect(proposals.filter((p) => p.type === "narrative.append")).toHaveLength(
      0,
    );
    // The event MUST still surface, with the right source.
    const evt = proposals.find((p) => p.type === "event.emit");
    expect(evt).toBeDefined();
    expect(evt!.source).toEqual(SOURCE);
  });
});
