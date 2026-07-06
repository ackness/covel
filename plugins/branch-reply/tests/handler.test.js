import { describe, expect, it, vi } from "vitest";
import { getPendingProposals } from "@covel/tools";
import handler from "../handler.js";

/**
 * Build a handler ctx. Pass `manualPayload` for the manual (plugin-rpc) path,
 * or leave it undefined and pass `completedResults` to exercise the auto seed
 * path. `extra` overrides any field (gateway, locale, logger, …).
 */
function ctx({ manualPayload, store = {}, completedResults, ...extra } = {}) {
  return {
    sessionId: "sess-branch",
    turnId: "turn-branch",
    pluginId: "branch-reply",
    runtimeId: "branch-reply",
    playerMessage: "I ask the guard to explain the sealed door.",
    store,
    completedResults: completedResults ?? new Map(),
    config: {},
    ...(manualPayload !== undefined ? { manualPayload } : {}),
    ...extra,
  };
}

function narrativeResult(runtimeId, narrativeOutput, status = "success") {
  return [
    runtimeId,
    {
      pluginId: runtimeId,
      runtimeId,
      status,
      output: { narrativeOutput },
    },
  ];
}

describe("branch-reply seed path (auto, no manualPayload)", () => {
  it("seeds candidate[0] from the active engine narrative, engine-agnostically", async () => {
    // Two engines could be present; the inactive one is suppressed to "". The
    // seed must pick the real narrative without keying on any plugin id.
    const completedResults = new Map([
      narrativeResult("scene-prompts", ""),
      narrativeResult(
        "chat-mode-narrator",
        "The guard exhales and finally meets your eyes.",
      ),
    ]);

    const result = await handler(ctx({ completedResults }));

    expect(result).toMatchObject({
      action: "seed",
      turnId: "turn-branch",
      seeded: true,
      candidateCount: 1,
    });

    const [proposal] = getPendingProposals(result);
    expect(proposal).toMatchObject({
      type: "plugin.data.batch",
      source: { pluginId: "branch-reply", runtimeId: "branch-reply" },
    });
    const items = proposal.payload.items;
    expect(items[0]).toMatchObject({
      namespace: "turns",
      key: "turn-branch",
      value: {
        schemaVersion: 1,
        turnId: "turn-branch",
        status: "ready",
        // Stores WHICH runtime produced the narrative so the prompt-history
        // rewriter targets the narrator's message, not branch-reply's own seed.
        runtimeId: "chat-mode-narrator",
        candidates: [
          {
            id: "turn-branch-candidate-1",
            index: 0,
            text: "The guard exhales and finally meets your eyes.",
            source: "original",
          },
        ],
      },
    });
    expect(items[1]).toMatchObject({
      namespace: "message",
      key: "turn-branch",
      value: { __turnId: "turn-branch", status: "ready", candidateCount: 1 },
    });
  });

  it("no-ops on empty / system turns (no narrative output)", async () => {
    const completedResults = new Map([narrativeResult("scene-prompts", "")]);
    const result = await handler(ctx({ completedResults }));
    expect(result).toMatchObject({ action: "seed", seeded: false });
    expect(getPendingProposals(result)).toHaveLength(0);
  });

  it("is idempotent per turnId — never double-seeds", async () => {
    const completedResults = new Map([
      narrativeResult("narrator", "A door opens onto a cold corridor."),
    ]);
    const pluginData = {
      // ctx.pluginData already holds a record for this turn.
      async get(namespace, key) {
        expect([namespace, key]).toEqual(["turns", "turn-branch"]);
        return {
          schemaVersion: 1,
          turnId: "turn-branch",
          candidates: [
            {
              id: "turn-branch-candidate-1",
              index: 0,
              text: "A door opens.",
            },
          ],
          status: "ready",
        };
      },
    };

    const result = await handler(ctx({ completedResults, pluginData }));
    expect(result).toMatchObject({ action: "seed", seeded: false });
    expect(getPendingProposals(result)).toHaveLength(0);
  });
});

describe("branch-reply createCandidates (regenerate)", () => {
  it("produces genuine LLM variants in addition to the original", async () => {
    const gateway = {
      generateText: vi.fn().mockResolvedValue({
        text: "Variant one of the beat.\n---\nVariant two of the beat.",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    const result = await handler(
      ctx({
        manualPayload: {
          action: "createCandidates",
          turnId: "turn-42",
          baseText: "The original beat as written by the narrator.",
          count: 3,
        },
        gateway,
        locale: "zh-CN",
      }),
    );

    expect(gateway.generateText).toHaveBeenCalledTimes(1);
    expect(gateway.generateText.mock.calls[0][0]).toMatchObject({
      presetId: "fast",
    });

    expect(result).toMatchObject({
      action: "createCandidates",
      turnId: "turn-42",
      candidateCount: 3,
      selectedCandidateId: "turn-42-candidate-1",
    });

    const [proposal] = getPendingProposals(result);
    const candidates = proposal.payload.items[0].value.candidates;
    expect(candidates.map((c) => c.text)).toEqual([
      "The original beat as written by the narrator.",
      "Variant one of the beat.",
      "Variant two of the beat.",
    ]);
    expect(candidates[0].source).toBe("original");
    expect(candidates[1].source).toBe("regenerated");
  });

  it("carries the seeded narrator runtimeId forward through regenerate", async () => {
    // The block was seeded earlier with runtimeId = the narrator. Regenerate
    // must read it back and re-store it so a later accept still targets the
    // narrator's message, not branch-reply's own seed message.
    const pluginData = {
      async get(namespace, key) {
        expect([namespace, key]).toEqual(["turns", "turn-42"]);
        return {
          schemaVersion: 1,
          turnId: "turn-42",
          runtimeId: "chat-mode-narrator",
          status: "ready",
          candidates: [
            { id: "turn-42-candidate-1", index: 0, text: "Seeded original." },
          ],
        };
      },
    };
    const gateway = {
      generateText: vi.fn().mockResolvedValue({
        text: "A fresh rephrasing.",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    const result = await handler(
      ctx({
        manualPayload: {
          action: "createCandidates",
          turnId: "turn-42",
          baseText: "Seeded original.",
          count: 3,
        },
        pluginData,
        gateway,
      }),
    );

    const [proposal] = getPendingProposals(result);
    expect(proposal.payload.items[0].value.runtimeId).toBe(
      "chat-mode-narrator",
    );
  });

  it("returns only the base text (no English filler) when no gateway is wired", async () => {
    const result = await handler(
      ctx({
        manualPayload: {
          action: "createCandidates",
          turnId: "turn-42",
          baseText: "I test the lock with the brass key.",
          count: 3,
        },
      }),
    );

    expect(result).toMatchObject({
      action: "createCandidates",
      turnId: "turn-42",
      candidateCount: 1,
    });

    const [proposal] = getPendingProposals(result);
    const candidates = proposal.payload.items[0].value.candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].text).toBe("I test the lock with the brass key.");
    expect(candidates[0].source).toBe("original");
  });

  it("falls back to base text only when the gateway throws", async () => {
    const gateway = {
      generateText: vi.fn().mockRejectedValue(new Error("no slot configured")),
    };
    const warn = vi.fn();
    const result = await handler(
      ctx({
        manualPayload: {
          action: "createCandidates",
          turnId: "turn-42",
          baseText: "The original beat.",
          count: 3,
        },
        gateway,
        logger: { warn },
      }),
    );

    const [proposal] = getPendingProposals(result);
    const candidates = proposal.payload.items[0].value.candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].text).toBe("The original beat.");
    expect(warn).toHaveBeenCalled();
  });

  it("uses an explicit candidate list verbatim without calling the gateway", async () => {
    // Explicit `candidates` IS the full candidate set (candidate[0] =
    // candidates[0]); the programmatic / API contract is preserved.
    const gateway = { generateText: vi.fn() };
    const result = await handler(
      ctx({
        manualPayload: {
          action: "createCandidates",
          turnId: "turn-42",
          candidates: ["First explicit line.", "Second explicit line."],
          count: 3,
        },
        gateway,
      }),
    );

    expect(gateway.generateText).not.toHaveBeenCalled();
    const [proposal] = getPendingProposals(result);
    const candidates = proposal.payload.items[0].value.candidates;
    expect(candidates.map((c) => c.text)).toEqual([
      "First explicit line.",
      "Second explicit line.",
    ]);
    expect(candidates.every((c) => c.source === "manual")).toBe(true);
  });

  it("requires selectedCandidateId to reference a generated candidate", async () => {
    await expect(
      handler(
        ctx({
          manualPayload: {
            action: "createCandidates",
            turnId: "turn-42",
            count: 2,
            selectedCandidateId: "missing-candidate",
          },
        }),
      ),
    ).rejects.toThrow(
      "manualPayload.selectedCandidateId must reference an existing candidate",
    );
  });
});

describe("branch-reply acceptCandidate", () => {
  it("accepts a stored candidate and updates both records", async () => {
    const storedTurn = {
      schemaVersion: 1,
      turnId: "turn-42",
      baseText: "I test the lock.",
      runtimeId: "chat-mode-narrator",
      candidates: [
        {
          id: "turn-42-candidate-1",
          index: 0,
          text: "I test the lock.",
          source: "original",
        },
        {
          id: "turn-42-candidate-2",
          index: 1,
          text: "I test the lock. I listen.",
          source: "regenerated",
        },
      ],
      selectedCandidateId: "turn-42-candidate-1",
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const pluginData = {
      async get(namespace, key) {
        expect([namespace, key]).toEqual(["turns", "turn-42"]);
        return storedTurn;
      },
    };

    const result = await handler(
      ctx({
        manualPayload: {
          action: "acceptCandidate",
          turnId: "turn-42",
          candidateId: "turn-42-candidate-2",
        },
        pluginData,
      }),
    );

    expect(result).toMatchObject({
      action: "acceptCandidate",
      turnId: "turn-42",
      acceptedCandidateId: "turn-42-candidate-2",
      acceptedText: "I test the lock. I listen.",
    });

    const [proposal] = getPendingProposals(result);
    const items = proposal.payload.items;
    expect(items[0]).toMatchObject({
      namespace: "turns",
      key: "turn-42",
      value: {
        status: "accepted",
        // runtimeId survives accept so the rewriter targets the narrator.
        runtimeId: "chat-mode-narrator",
        selectedCandidateId: "turn-42-candidate-2",
        acceptedCandidateId: "turn-42-candidate-2",
        acceptedText: "I test the lock. I listen.",
      },
    });
    expect(items[1]).toMatchObject({
      namespace: "message",
      key: "turn-42",
      value: {
        __turnId: "turn-42",
        status: "accepted",
        selectedCandidateId: "turn-42-candidate-2",
        acceptedCandidateId: "turn-42-candidate-2",
      },
    });
  });

  it("rejects acceptCandidate when the turn record is missing", async () => {
    const pluginData = {
      async get() {
        return null;
      },
    };

    await expect(
      handler(
        ctx({
          manualPayload: {
            action: "acceptCandidate",
            turnId: "turn-42",
            candidateId: "turn-42-candidate-1",
          },
          pluginData,
        }),
      ),
    ).rejects.toThrow("branch-reply turn record was not found");
  });

  it("rejects acceptCandidate when candidateId is not in the stored turn record", async () => {
    const pluginData = {
      async get() {
        return {
          schemaVersion: 1,
          turnId: "turn-42",
          baseText: "I test the lock.",
          candidates: [
            {
              id: "turn-42-candidate-1",
              index: 0,
              text: "I test the lock.",
              source: "original",
            },
          ],
          selectedCandidateId: "turn-42-candidate-1",
          status: "ready",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    };

    await expect(
      handler(
        ctx({
          manualPayload: {
            action: "acceptCandidate",
            turnId: "turn-42",
            candidateId: "turn-42-candidate-9",
          },
          pluginData,
        }),
      ),
    ).rejects.toThrow(
      "manualPayload.candidateId must reference an existing candidate",
    );
  });
});

describe("branch-reply malformed manual payloads", () => {
  it("rejects non-object and unknown actions", async () => {
    await expect(handler(ctx({ manualPayload: null }))).rejects.toThrow(
      "manualPayload must be an object",
    );
    await expect(
      handler(ctx({ manualPayload: { action: "unknown" } })),
    ).rejects.toThrow(
      "manualPayload.action must be createCandidates or acceptCandidate",
    );
    await expect(
      handler(
        ctx({
          manualPayload: { action: "createCandidates", turnId: "../bad" },
        }),
      ),
    ).rejects.toThrow("turnId must be 1-128 characters");
    await expect(
      handler(
        ctx({ manualPayload: { action: "createCandidates", count: 99 } }),
      ),
    ).rejects.toThrow("manualPayload.count must be an integer");
  });
});
