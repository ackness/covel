/**
 * The steering queue closes as soon as no runtime of the execution can read a
 * player's interjection. Its owner then refuses a late interjection instead
 * of accepting text that no model call would see.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { trackSteeringReaders } from "../src/turn-executor/turn-control.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

const narrator = {
  name: "narrator",
  pluginId: "narrator",
  description: "narrator",
  stage: "narrative",
  outputKind: "story",
  trigger: { type: "auto" },
} as RuntimeManifest;

// A function runtime after the story: the bookkeeping part of a turn.
const ledger = {
  name: "ledger",
  pluginId: "ledger",
  description: "ledger",
  stage: "post-turn",
  runtimeType: "function",
  handler: "./h.js",
  trigger: { type: "auto" },
} as RuntimeManifest;

const input: TurnInput = {
  origin: "player",
  sessionId: "sess-steer",
  turnId: "turn-steer",
  playerMessage: "open the door",
};

const prose: LLMResponse = {
  content: "The door opens.",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
};

/** Run one execution and record when the queue closed relative to the work. */
async function timelineOf(turnInput: TurnInput): Promise<string[]> {
  const timeline: string[] = [];
  const deps: TurnExecutorDeps = {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: "prompt",
      ...(m.runtimeType === "function"
        ? {
            handler: async () => {
              timeline.push(`ran:${m.name}`);
              return { outcome: "success" as const, value: {} };
            },
          }
        : {}),
    }),
    llm: {
      generate: async () => {
        timeline.push("story-call");
        return prose;
      },
    } as LLMAdapter,
    store: createMemoryStore(),
    turnControl: {
      drainSteering: () => [],
      closeSteering: () => {
        timeline.push("steering-closed");
      },
    },
  };
  await executeTurn(turnInput, [narrator, ledger], deps, { maxSteps: 3 });
  return timeline;
}

describe("executeTurn steering queue", () => {
  it("closes the queue when the story runtime ends, before bookkeeping runs", async () => {
    expect(await timelineOf(input)).toEqual([
      "story-call",
      "steering-closed",
      "ran:ledger",
    ]);
  });

  it("closes the queue before a retried bookkeeping runtime starts", async () => {
    expect(
      await timelineOf({
        ...input,
        manualTrigger: { runtimeId: "ledger", sourceTurnId: "turn-source" },
      }),
    ).toEqual(["steering-closed", "ran:ledger"]);
    expect(
      await timelineOf({
        ...input,
        manualTrigger: { runtimeIds: ["ledger"], sourceTurnId: "turn-source" },
      }),
    ).toEqual(["steering-closed", "ran:ledger"]);
  });

  it("keeps the queue open while a retried story runtime runs", async () => {
    expect(
      await timelineOf({
        ...input,
        manualTrigger: { runtimeId: "narrator", sourceTurnId: "turn-source" },
      }),
    ).toEqual(["story-call", "steering-closed"]);
  });
});

describe("trackSteeringReaders", () => {
  const closesOf = (
    scheduled: readonly RuntimeManifest[],
    eventFollowers: readonly RuntimeManifest[] = [],
  ) => {
    const closes: string[] = [];
    const readers = trackSteeringReaders({
      control: { closeSteering: () => closes.push("closed") },
      scheduled,
      eventFollowers,
    });
    return { closes, readers };
  };

  it("waits for every scheduled story agent and closes once", () => {
    const second = { ...narrator, name: "epilogue" } as RuntimeManifest;
    const { closes, readers } = closesOf([narrator, second, ledger]);

    readers.settled("ledger");
    readers.settled("narrator");
    expect(closes).toEqual([]);
    readers.settled("epilogue");
    readers.close();
    expect(closes).toEqual(["closed"]);
  });

  it("does not count a function runtime with story output as a reader", () => {
    const welcome = {
      ...ledger,
      name: "welcome",
      outputKind: "story",
    } as RuntimeManifest;

    expect(closesOf([welcome]).closes).toEqual(["closed"]);
  });

  it("stays open for a story agent that an event may still start", () => {
    const interlude = {
      ...narrator,
      name: "interlude",
      stage: undefined,
      trigger: { type: "event", topic: "scene.changed" },
    } as RuntimeManifest;
    const { closes, readers } = closesOf([narrator], [interlude, ledger]);

    readers.settled("narrator");
    expect(closes).toEqual([]);
    readers.close();
    expect(closes).toEqual(["closed"]);
  });
});
