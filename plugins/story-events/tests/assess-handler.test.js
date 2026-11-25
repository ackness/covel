import {
  getPendingProposals,
  getToolContent,
} from "@covel/plugin-handlers-utils";
import { describe, expect, it, vi } from "vitest";
import assessHandler from "../runtimes/assess/handler.js";
import evaluateHandler from "../runtimes/evaluate/handler.js";

function makeStore(initial = {}) {
  const buckets = new Map();
  for (const [ns, entries] of Object.entries(initial)) {
    buckets.set(ns, new Map(Object.entries(entries)));
  }
  return {
    buckets,
    pluginData: {
      list: async (ns) =>
        [...(buckets.get(ns)?.entries() ?? [])].map(([key, value]) => ({
          key,
          value,
        })),
      get: async (ns, key) => {
        const value = buckets.get(ns)?.get(key);
        return value === undefined ? null : { key, value };
      },
      set: async (ns, key, value) => {
        if (!buckets.has(ns)) buckets.set(ns, new Map());
        if (value === null) buckets.get(ns).delete(key);
        else buckets.get(ns).set(key, value);
      },
    },
    dump(ns) {
      return Object.fromEntries(buckets.get(ns)?.entries() ?? []);
    },
  };
}

describe("assess + evaluate end-to-end plugin lifecycle", () => {
  it("short-circuits deterministic gates (0 judge calls), unlocks hidden option when judged true, then reveals payload & rewards on selection", async () => {
    const hiddenEntry = {
      id: "su-yao-backroom",
      title: "The Duplicate Register",
      when: {
        all: [
          {
            dimension: "caseBoard",
            path: "letter.status",
            equals: "corroborated",
          },
          {
            judge: "Su Yao hesitates about the sealed archive.",
            id: "hesitates",
            watch: { characters: ["Su Yao"] },
          },
        ],
      },
      options: [
        {
          id: "ask-register",
          label: "Hidden Action",
          text: "Ask Su Yao about Qi's duplicate register.",
          hint: "Press her privately.",
          payload: "SECRET-OPT-PAYLOAD: Su Yao pulls out the register.",
          rewards: [
            {
              id: "r-lore",
              kind: "lorebook",
              title: "Archive Date Gap",
              entryId: "archive-date-gap",
              keys: ["archive"],
              content: "SECRET-LORE-CONTENT",
            },
          ],
        },
      ],
    };

    const store = makeStore({
      "_hidden.events": { [hiddenEntry.id]: hiddenEntry },
    });
    const runAgent = vi.fn();

    // Turn 1: deterministic gate fails -> judge is NOT called, option stays hidden.
    const t1 = await assessHandler({
      sessionId: "s-1",
      turnId: "t-1",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 1,
      recursionDepth: 0,
      playerMessage: "Hello Su Yao.",
      world: {
        dimensions: {
          caseBoard: {
            value: { letter: { status: "unverified" } },
            version: 1,
          },
        },
      },
      inputs: {
        narrative: {
          value: [
            { kind: "dialogue", speaker: "Su Yao", text: "Good evening." },
          ],
        },
        operations: { value: [] },
      },
      agents: { run: runAgent },
      pluginData: store.pluginData,
    });
    expect(t1.value.judged).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    expect(store.dump("active_options")).toEqual({});
    expect(store.dump("message")).toEqual({});

    // Turn 2: deterministic gate passes -> judge called ONCE with NO secrets -> option unlocks.
    runAgent.mockResolvedValueOnce({
      ok: true,
      output: {
        verdicts: [
          {
            key: "su-yao-backroom#hesitates",
            met: true,
            confidence: "high",
            evidence: "Su Yao looked away when the Sealed Archive came up.",
          },
        ],
        matchedOptionId: null,
      },
    });
    const t2 = await assessHandler({
      sessionId: "s-1",
      turnId: "t-2",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 2,
      recursionDepth: 0,
      playerMessage: "What happened at the archive?",
      world: {
        dimensions: {
          caseBoard: {
            value: { letter: { status: "corroborated" } },
            version: 2,
          },
        },
      },
      inputs: {
        narrative: {
          value: [
            {
              kind: "dialogue",
              speaker: "Su Yao",
              text: "The archive... I shouldn't say.",
            },
          ],
        },
        operations: { value: [] },
      },
      agents: { run: runAgent },
      pluginData: store.pluginData,
    });
    expect(t2.value.judged).toBe(true);
    expect(t2.value.unlockedOptions).toEqual(["ask-register"]);
    // Anti-spoiler check on judge prompt & public buckets.
    expect(JSON.stringify(runAgent.mock.calls[0][0])).not.toContain(
      "SECRET-OPT-PAYLOAD",
    );
    expect(JSON.stringify(runAgent.mock.calls[0][0])).not.toContain(
      "SECRET-LORE-CONTENT",
    );
    expect(JSON.stringify(store.dump("active_options"))).not.toContain(
      "SECRET",
    );
    expect(store.dump("message")["t-2"]?.hasOptions).toBe(true);

    // Turn 3 pre-turn: player clicks/sends the unlocked option -> cue delivered & lorebook reward staged.
    const t3Eval = await evaluateHandler({
      sessionId: "s-1",
      turnId: "t-3",
      pluginId: "story-events",
      runtimeId: "story-events/evaluate",
      locale: "en-US",
      logicalTurn: 3,
      playerMessage: "Ask Su Yao about Qi's duplicate register.",
      inputs: {
        dimensions: {
          value: {
            caseBoard: {
              value: { letter: { status: "corroborated" } },
              version: 2,
            },
          },
        },
      },
      pluginData: store.pluginData,
    });
    const evalResult = getToolContent(t3Eval);
    const evalProposals = getPendingProposals(t3Eval);
    expect(evalResult.value.cue).toMatchObject({
      eventId: "su-yao-backroom",
      optionId: "ask-register",
      payload: "SECRET-OPT-PAYLOAD: Su Yao pulls out the register.",
    });
    expect(evalResult.value.selectedOption).toEqual({
      eventId: "su-yao-backroom",
      optionId: "ask-register",
    });
    expect(evalProposals).toHaveLength(1);
    expect(evalProposals[0].type).toBe("lorebook.upsert");
    // Consumed once-option is removed from active_options and recorded in selected_options.
    expect(store.dump("active_options")).toEqual({});
    expect(store.dump("selected_options")["ask-register"]).toBeDefined();
    expect(
      store.dump("claimed_rewards")["su-yao-backroom:ask-register:r-lore"],
    ).toBeDefined();
  });

  it("arms semantic story events in audit and reveals them at 0ms on the next turn's evaluate", async () => {
    const semanticEvent = {
      id: "rift-with-meg",
      title: "Salt Fangs Retaliate",
      when: "The protagonist has publicly broken with Iron Meg.",
      payload: "Two Salt Fangs enforcers wait in the alley.",
    };
    const store = makeStore({
      "_hidden.events": { [semanticEvent.id]: semanticEvent },
    });
    const runAgent = vi.fn().mockResolvedValueOnce({
      ok: true,
      output: {
        verdicts: [
          {
            key: "rift-with-meg#0",
            met: true,
            confidence: "high",
            evidence: "You tore up Meg's deal in front of her crew.",
          },
        ],
        matchedOptionId: null,
      },
    });

    const t1 = await assessHandler({
      sessionId: "s-1",
      turnId: "t-1",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 1,
      recursionDepth: 0,
      playerMessage: "I tear up her deal.",
      world: { dimensions: {} },
      inputs: {
        narrative: {
          value: [
            {
              kind: "narration",
              text: "You tear up Meg's offer in front of everyone.",
            },
          ],
        },
        operations: { value: [] },
      },
      agents: { run: runAgent },
      pluginData: store.pluginData,
    });
    expect(t1.value.armed).toEqual(["rift-with-meg"]);
    expect(store.dump("_hidden.armed")["rift-with-meg"]).toBeDefined();

    // Next turn pre-turn reveals the armed event with zero judge calls.
    const t2Eval = await evaluateHandler({
      sessionId: "s-1",
      turnId: "t-2",
      pluginId: "story-events",
      runtimeId: "story-events/evaluate",
      locale: "en-US",
      logicalTurn: 2,
      playerMessage: "I head back to my lodgings.",
      inputs: {},
      pluginData: store.pluginData,
    });
    expect(t2Eval.value.cue).toMatchObject({
      eventId: "rift-with-meg",
      payload: "Two Salt Fangs enforcers wait in the alley.",
    });
    expect(store.dump("_hidden.armed")).toEqual({});
  });

  it("supports explicit timing: pre-turn semantic evaluation and requireOutcome reward verification", async () => {
    const instantEvent = {
      id: "codeword-door",
      title: "The Hidden Latch",
      timing: "pre-turn",
      when: {
        all: [
          { dimension: "location", equals: "lighthouse" },
          {
            judge: "The player speaks the watchman's codeword.",
            id: "codeword",
            scope: "player-input",
          },
        ],
      },
      payload: "The hidden bolt slides back immediately.",
      rewards: [
        {
          id: "vault-map",
          kind: "narrative",
          title: "Vault Map",
          text: "You recover the waterproof vault map.",
          requireOutcome: true,
        },
      ],
    };
    const store = makeStore({
      "_hidden.events": { [instantEvent.id]: instantEvent },
    });
    const runAgent = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        output: {
          verdicts: [
            {
              key: "codeword-door#codeword",
              met: true,
              confidence: "high",
              evidence: "Player spoke the codeword.",
            },
          ],
          matchedOptionId: null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: {
          verdicts: [
            {
              key: "outcome:codeword-door::vault-map",
              met: true,
              confidence: "medium",
              evidence: "The narrative confirms the player took the map.",
            },
          ],
          matchedOptionId: null,
        },
      });

    // Pre-turn fires immediately and defers requireOutcome reward to audit.
    const t1Eval = await evaluateHandler({
      sessionId: "s-1",
      turnId: "t-1",
      pluginId: "story-events",
      runtimeId: "story-events/evaluate",
      locale: "en-US",
      logicalTurn: 1,
      playerMessage: "I whisper: three bells at low tide.",
      inputs: {
        dimensions: {
          value: { location: { value: "lighthouse", version: 1 } },
        },
      },
      agents: { run: runAgent },
      pluginData: store.pluginData,
    });
    expect(t1Eval.value.cue?.eventId).toBe("codeword-door");
    expect(store.dump("claimed_rewards")).toEqual({});
    expect(
      store.dump("_hidden.pending_options")["codeword-door::vault-map"],
    ).toBeDefined();

    // Audit verifies the outcome and grants the reward.
    const t1Assess = await assessHandler({
      sessionId: "s-1",
      turnId: "t-1",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 1,
      recursionDepth: 0,
      playerMessage: "I whisper: three bells at low tide.",
      world: { dimensions: { location: { value: "lighthouse", version: 1 } } },
      inputs: {
        narrative: {
          value: [
            {
              kind: "narration",
              text: "The latch slides open and you pull the waterproof vault map from the niche.",
            },
          ],
        },
        operations: { value: [] },
      },
      agents: { run: runAgent },
      pluginData: store.pluginData,
    });
    expect(t1Assess.value.rewardsGranted).toEqual(["codeword-door::vault-map"]);
    expect(
      store.dump("claimed_rewards")["codeword-door::vault-map"],
    ).toBeDefined();
    expect(store.dump("message")["t-1"]?.hasRewards).toBe(true);
  });

  it("recognizes rewritten hidden options via judge fallback and enforces exclusive options", async () => {
    const exclusiveEvent = {
      id: "fork-choice",
      exclusive: true,
      when: { dimension: "location", equals: "dock" },
      options: [
        {
          id: "opt-a",
          text: "Hand the forged ledger to the council guard.",
          payload: "The guard pockets the ledger.",
          rewards: [
            { id: "ra", kind: "narrative", text: "Guard owes you a favor." },
          ],
        },
        {
          id: "opt-b",
          text: "Burn the ledger in the brazier.",
          payload: "The pages curl into ash.",
        },
      ],
    };
    const store = makeStore({
      "_hidden.events": { [exclusiveEvent.id]: exclusiveEvent },
      active_options: {
        "opt-a": {
          id: "opt-a",
          eventId: "fork-choice",
          text: "Hand the forged ledger to the council guard.",
          exclusive: true,
          once: true,
        },
        "opt-b": {
          id: "opt-b",
          eventId: "fork-choice",
          text: "Burn the ledger in the brazier.",
          exclusive: true,
          once: true,
        },
      },
    });
    const runAgent = vi.fn().mockResolvedValueOnce({
      ok: true,
      output: { verdicts: [], matchedOptionId: "opt-a" },
    });

    const t1 = await assessHandler({
      sessionId: "s-1",
      turnId: "t-1",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 1,
      recursionDepth: 0,
      playerMessage: "I quietly slip the fake ledger to the guard on duty.",
      world: { dimensions: { location: { value: "dock", version: 1 } } },
      inputs: {
        narrative: {
          value: [
            { kind: "narration", text: "The guard takes the fake ledger." },
          ],
        },
        operations: { value: [] },
      },
      agents: { run: runAgent },
      pluginData: store.pluginData,
    });

    expect(t1.value.armed).toContain("fork-choice:opt-a");
    expect(store.dump("selected_options")["opt-a"]).toBeDefined();
    // Exclusive event closes opt-b as soon as opt-a is chosen.
    expect(store.dump("active_options")).toEqual({});
    expect(store.dump("claimed_rewards")["fork-choice:opt-a:ra"]).toBeDefined();
  });

  it("writes __turnId on message surface records and keeps payload-event options hidden until revealed", async () => {
    const spoiledEvent = {
      id: "secret-visitor",
      when: "The keeper mentions the midnight visitor.",
      payload: "A hooded figure knocks at the lighthouse door.",
      options: [
        {
          id: "open-door",
          text: "Unbolt the door for the hooded visitor.",
          payload: "The visitor steps inside.",
        },
      ],
    };
    const store = makeStore({
      "_hidden.events": { [spoiledEvent.id]: spoiledEvent },
    });
    const runAgent = vi.fn().mockResolvedValueOnce({
      ok: true,
      output: {
        verdicts: [
          {
            key: "secret-visitor#0",
            met: true,
            confidence: "high",
            evidence: "The keeper spoke of a midnight visitor.",
          },
        ],
        matchedOptionId: null,
      },
    });

    // Turn 1 audit: event is armed for next turn, NOT yet revealed -> options stay hidden.
    const t1 = await assessHandler({
      sessionId: "s-1",
      turnId: "t-1",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 1,
      recursionDepth: 0,
      playerMessage: "Who comes at midnight?",
      world: { dimensions: {} },
      inputs: {
        narrative: {
          value: [
            {
              kind: "narration",
              text: "He whispers about a midnight visitor.",
            },
          ],
        },
        operations: { value: [] },
      },
      agents: { run: runAgent },
      pluginData: store.pluginData,
    });
    expect(t1.value.armed).toEqual(["secret-visitor"]);
    expect(t1.value.unlockedOptions).toEqual([]);
    expect(store.dump("active_options")).toEqual({});

    // Turn 2 pre-turn reveals the event, then Turn 2 audit unlocks its option with `__turnId`.
    const t2Eval = await evaluateHandler({
      sessionId: "s-1",
      turnId: "t-2",
      pluginId: "story-events",
      runtimeId: "story-events/evaluate",
      locale: "en-US",
      logicalTurn: 2,
      playerMessage: "I wait by the lamp.",
      inputs: {},
      pluginData: store.pluginData,
    });
    expect(t2Eval.value.cue?.eventId).toBe("secret-visitor");

    const t2Assess = await assessHandler({
      sessionId: "s-1",
      turnId: "t-2",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 2,
      recursionDepth: 0,
      playerMessage: "I wait by the lamp.",
      world: { dimensions: {} },
      inputs: {
        narrative: {
          value: [{ kind: "narration", text: "A knock echoes at the door." }],
        },
        operations: { value: [] },
      },
      agents: { run: runAgent },
      pluginData: store.pluginData,
    });
    expect(t2Assess.value.unlockedOptions).toEqual(["open-door"]);
    expect(store.dump("message")["t-2"]?.__turnId).toBe("t-2");
    expect(store.dump("message")["t-2"]?.turnId).toBeUndefined();
  });

  it("preserves pending requireOutcome records when semanticJudge is disabled or fails, and verifies requireOutcome on pure-reward events", async () => {
    const pureOutcomeEvent = {
      id: "vault-prize",
      when: { dimension: "location", equals: "vault" },
      rewards: [
        {
          id: "emerald",
          kind: "narrative",
          text: "You pocket the harbor emerald.",
          requireOutcome: true,
        },
      ],
    };
    const pendingEntry = {
      rewardKey: "vault-prize::emerald",
      eventId: "vault-prize",
      rewardId: "emerald",
      turn: 1,
      turnId: "t-1",
      sourceTurnId: "t-1",
    };

    // 1. Disabled semantic judge preserves pending entry instead of deleting it.
    const disabledStore = makeStore({
      "_hidden.events": { [pureOutcomeEvent.id]: pureOutcomeEvent },
      "_hidden.pending_options": { "vault-prize::emerald": pendingEntry },
    });
    const disabledRes = await assessHandler({
      sessionId: "s-1",
      turnId: "t-1",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 1,
      recursionDepth: 0,
      userSettings: { semanticJudge: false },
      playerMessage: "Grab the emerald.",
      world: { dimensions: { location: { value: "vault", version: 1 } } },
      inputs: { narrative: { value: [] }, operations: { value: [] } },
      agents: { run: vi.fn() },
      pluginData: disabledStore.pluginData,
    });
    expect(disabledRes.value.rewardsGranted).toEqual([]);
    expect(
      disabledStore.dump("_hidden.pending_options")["vault-prize::emerald"],
    ).toBeDefined();
    expect(disabledStore.dump("claimed_rewards")).toEqual({});

    // 2. Transient judge failure preserves pending entry so a retry can still verify it.
    const retryStore = makeStore({
      "_hidden.events": { [pureOutcomeEvent.id]: pureOutcomeEvent },
      "_hidden.pending_options": { "vault-prize::emerald": pendingEntry },
    });
    const flakyAgent = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "timeout", message: "transient" },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: {
          verdicts: [
            {
              key: "outcome:vault-prize::emerald",
              met: true,
              confidence: "high",
              evidence: "Narrative confirmed you took the emerald.",
            },
          ],
          matchedOptionId: null,
        },
      });
    const failedTry = await assessHandler({
      sessionId: "s-1",
      turnId: "t-1",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 1,
      recursionDepth: 0,
      playerMessage: "Grab the emerald.",
      world: { dimensions: { location: { value: "vault", version: 1 } } },
      inputs: {
        narrative: { value: [{ kind: "narration", text: "You pocket it." }] },
        operations: { value: [] },
      },
      agents: { run: flakyAgent },
      pluginData: retryStore.pluginData,
    });
    expect(failedTry.value.rewardsGranted).toEqual([]);
    expect(
      retryStore.dump("_hidden.pending_options")["vault-prize::emerald"],
    ).toBeDefined();

    // Retry of the same sourceTurnId verifies and grants it cleanly.
    const secondTry = await assessHandler({
      sessionId: "s-1",
      turnId: "t-1b",
      execution: { sourceTurnId: "t-1" },
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 1,
      recursionDepth: 0,
      playerMessage: "Grab the emerald.",
      world: { dimensions: { location: { value: "vault", version: 1 } } },
      inputs: {
        narrative: { value: [{ kind: "narration", text: "You pocket it." }] },
        operations: { value: [] },
      },
      agents: { run: flakyAgent },
      pluginData: retryStore.pluginData,
    });
    expect(secondTry.value.rewardsGranted).toEqual(["vault-prize::emerald"]);
    expect(retryStore.dump("_hidden.pending_options")).toEqual({});

    // 3. Pure-reward event with requireOutcome=true does NOT grant when judge says met=false.
    const deniedStore = makeStore({
      "_hidden.events": { [pureOutcomeEvent.id]: pureOutcomeEvent },
    });
    const denyAgent = vi.fn().mockResolvedValueOnce({
      ok: true,
      output: {
        verdicts: [
          {
            key: "outcome:vault-prize::emerald",
            met: false,
            confidence: "high",
            evidence: "The trap slammed shut before you could reach it.",
          },
        ],
        matchedOptionId: null,
      },
    });
    const denied = await assessHandler({
      sessionId: "s-1",
      turnId: "t-2",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      logicalTurn: 2,
      recursionDepth: 0,
      playerMessage: "Reach for the emerald.",
      world: { dimensions: { location: { value: "vault", version: 1 } } },
      inputs: {
        narrative: {
          value: [{ kind: "narration", text: "The grille slams shut." }],
        },
        operations: { value: [] },
      },
      agents: { run: denyAgent },
      pluginData: deniedStore.pluginData,
    });
    expect(denied.value.rewardsGranted).toEqual([]);
    expect(deniedStore.dump("claimed_rewards")).toEqual({});
  });
});
