import { describe, expect, it, vi } from "vitest";
import {
  buildJudgeRequest,
  buildTurnSignals,
  passesWatch,
  runSemanticJudge,
} from "../lib/judge.js";

describe("semantic judge funnel and anti-spoiler boundary", () => {
  const baseSignals = buildTurnSignals({
    narrativeSegments: [
      {
        kind: "dialogue",
        speaker: "Su Yao",
        text: "Keep your voice down about the archive.",
      },
    ],
    playerMessage: "I ask Su Yao about the missing page.",
    worldIR: {
      summary: "Su Yao warns the player about the Sealed Archive.",
      entities: [{ id: "su-yao", name: "Su Yao", type: "character" }],
      events: [{ type: "interaction", description: "Su Yao hesitated." }],
    },
    dimensions: {
      caseBoard: {
        value: { "torn-letter": { status: "corroborated" } },
        version: 2,
      },
    },
    worldTime: { phase: 3 },
    turn: 5,
  });

  it("enforces watch hints (characters, keywords, dimensions, every, fingerprint)", () => {
    const item = {
      key: "ev#1",
      question: "Su Yao hesitates",
      scope: "narrative",
      sticky: true,
      watch: { characters: ["Su Yao"], keywords: ["archive"] },
      cached: null,
    };
    expect(passesWatch(item, baseSignals)).toBe(true);
    expect(
      passesWatch(
        { ...item, watch: { characters: ["Iron Meg"] } },
        baseSignals,
      ),
    ).toBe(false);
    expect(
      passesWatch(
        { ...item, watch: { keywords: ["lighthouse"] } },
        baseSignals,
      ),
    ).toBe(false);
    expect(
      passesWatch(
        {
          ...item,
          watch: { every: 3 },
          cached: { turn: 4, fingerprint: "different" },
        },
        baseSignals,
      ),
    ).toBe(false);
    expect(
      passesWatch(
        {
          ...item,
          watch: null,
          cached: { turn: 4, fingerprint: baseSignals.fingerprint },
        },
        baseSignals,
      ),
    ).toBe(false);
    expect(
      passesWatch(
        {
          ...item,
          watch: { dimensions: ["caseBoard"] },
          cached: {
            turn: 4,
            fingerprint: "other",
            dimensionVersions: { caseBoard: 2 },
          },
        },
        baseSignals,
      ),
    ).toBe(false);
    expect(
      passesWatch(
        {
          ...item,
          watch: { dimensions: ["caseBoard"] },
          cached: {
            turn: 4,
            fingerprint: "other",
            dimensionVersions: { caseBoard: 1 },
          },
        },
        baseSignals,
      ),
    ).toBe(true);
  });

  it("never leaks hidden payloads, options, or rewards into the judge request", () => {
    const req = buildJudgeRequest({
      candidates: [
        {
          key: "ev#cond",
          question: "Su Yao hesitates about the archive",
          scope: "narrative",
          // Extra properties on candidate must never leak into `data`.
          payload: "TOP-SECRET-PAYLOAD",
          rewards: [{ id: "r1", item: "SECRET-KEY" }],
        },
      ],
      activeOptions: [
        {
          id: "opt-1",
          text: "Ask about the duplicate register",
          payload: "HIDDEN-OPT-PAYLOAD",
        },
      ],
      signals: baseSignals,
    });
    const serialized = JSON.stringify(req);
    expect(serialized).toContain("Su Yao hesitates about the archive");
    expect(serialized).toContain("Ask about the duplicate register");
    expect(serialized).not.toContain("TOP-SECRET-PAYLOAD");
    expect(serialized).not.toContain("SECRET-KEY");
    expect(serialized).not.toContain("HIDDEN-OPT-PAYLOAD");
  });

  it("makes zero calls when empty, enforces confidence & whitelist, and falls back on ambiguous contract", async () => {
    const run = vi.fn();
    const empty = await runSemanticJudge(
      { agents: { run } },
      { candidates: [], activeOptions: [], signals: baseSignals },
    );
    expect(empty.called).toBe(false);
    expect(run).not.toHaveBeenCalled();

    // Ambiguous contract falls back to story-events/judge.
    run
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "ambiguous", message: "multiple providers" },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: {
          verdicts: [
            {
              key: "a#1",
              met: true,
              confidence: "high",
              evidence: "Explicitly shown.",
            },
            {
              key: "b#1",
              met: true,
              confidence: "low",
              evidence: "Weak guess.",
            },
            {
              key: "injected#99",
              met: true,
              confidence: "high",
              evidence: "Unrequested.",
            },
          ],
          matchedOptionId: "opt-known",
        },
      });

    const result = await runSemanticJudge(
      { agents: { run } },
      {
        candidates: [
          { key: "a#1", question: "Condition A", scope: "narrative" },
          { key: "b#1", question: "Condition B", scope: "narrative" },
          { key: "c#1", question: "Condition C", scope: "narrative" },
        ],
        activeOptions: [{ id: "opt-known", text: "Show the note" }],
        signals: baseSignals,
        maxJudged: 2,
      },
    );

    expect(result.called).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0].target).toEqual({
      contract: "story-event.judge@1",
    });
    expect(run.mock.calls[1][0].target).toEqual({
      runtimeId: "story-events/judge",
    });
    // Capped at maxJudged=2: c#1 was not sent.
    expect(run.mock.calls[1][0].data.conditions).toHaveLength(2);
    expect(result.verdicts.get("a#1")?.met).toBe(true);
    // Low confidence is treated conservatively as unmet.
    expect(result.verdicts.get("b#1")?.met).toBe(false);
    // Unknown key is dropped by whitelist.
    expect(result.verdicts.has("injected#99")).toBe(false);
    expect(result.matchedOptionId).toBe("opt-known");
  });

  it("preserves structured worldIR fields and enforces dimension JSON budgets via modelFacingJson", () => {
    const signals = buildTurnSignals({
      narrativeSegments: [{ kind: "narration", text: "The dock is quiet." }],
      playerMessage: "Inspect the crate.",
      worldIR: {
        summary: "Crate inspected.",
        entities: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Brass Key",
            type: "item",
            description: "Stamped with a seal.",
          },
        ],
        relations: [{ type: "knows", from: "Hero", to: "Keeper" }],
        events: [{ type: "discovery", description: "Found a hidden notch." }],
        statements: [{ type: "claim", content: "The ledger was altered." }],
      },
      dimensions: {
        shortDim: {
          value: {
            note: "ok",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          version: 1,
        },
        oversizedDim: {
          value: { blob: "x".repeat(3500) },
          version: 1,
        },
      },
      worldTime: { phase: 2 },
      turn: 3,
    });

    // Structured worldIR fields survive when within budget.
    expect(signals.worldIR?.entities).toEqual([
      { name: "Brass Key", type: "item", description: "Stamped with a seal." },
    ]);
    expect(signals.worldIR?.relations).toHaveLength(1);
    expect(signals.worldIR?.events).toHaveLength(1);
    expect(signals.worldIR?.statements).toHaveLength(1);

    // Dimensions respect the 3000-char JSON budget and strip bookkeeping timestamps.
    expect(signals.dimensions.shortDim).toEqual({ note: "ok" });
    expect(signals.dimensions.oversizedDim).toBeUndefined();
    expect(JSON.stringify(signals.dimensions).length).toBeLessThanOrEqual(3000);

    // Oversized worldIR falls back cleanly to truncated summary.
    const hugeSignals = buildTurnSignals({
      narrativeSegments: [],
      playerMessage: "",
      worldIR: {
        summary: "Summary text.",
        events: Array.from({ length: 16 }, (_, idx) => ({
          type: "event",
          description: `detail-${idx}-${"a".repeat(350)}`,
        })),
      },
      dimensions: {},
      worldTime: null,
      turn: 4,
    });
    expect(hugeSignals.worldIR).toEqual({ summary: "Summary text." });
  });
});
