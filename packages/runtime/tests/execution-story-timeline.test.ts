/**
 * The conversation an agent reads must include the story text its own
 * execution already produced. The committed history stops at the previous
 * turn, so a runtime that runs after the story used to read a conversation
 * that ended on the previous narrative and the new player message, and it
 * answered that stale state.
 */

import { describe, expect, it } from "vitest";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { attachRuntimeJournal } from "../src/execution-journal.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type {
  LLMAdapter,
  LLMMessage,
  LLMRequest,
} from "../src/llm/llm-adapter.js";

const now = "2026-10-05T00:00:00.000Z";
const PRIOR_NARRATIVE = "The king offers a second bargain. Will you take it?";
const NARRATIVE = "You press the wick into the bowl. The flame holds.";
const CUE =
  "The story text above was written in this turn, after the player's message. The story now stands at its end. Do this runtime's task as the system instructions define.";

const narrator = {
  name: "narrator",
  pluginId: "narrator",
  description: "story",
  stage: "narrative",
  runtimeType: "agent",
  outputKind: "story",
} as RuntimeManifest;

function observer(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "observer",
    pluginId: "observer",
    description: "reads the turn after the story",
    stage: "post-turn",
    runtimeType: "agent",
    outputKind: "system",
    ...overrides,
  } as RuntimeManifest;
}

async function seedSession(): Promise<DataStore> {
  const store = createMemoryStore();
  await store.createSession({
    id: "s",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    locale: "en-US",
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
  await store.appendTurnMessage({
    id: "m1",
    sessionId: "s",
    turnId: "t1",
    sourceType: "player",
    role: "user",
    content: "I carry the wick to the stone seat.",
    order: 0,
    createdAt: now,
  });
  await store.appendTurnMessage({
    id: "m2",
    sessionId: "s",
    turnId: "t1",
    sourceType: "runtime",
    sourcePluginId: "narrator",
    sourceRuntimeId: "narrator",
    role: "assistant",
    name: "narrator",
    content: PRIOR_NARRATIVE,
    order: 2,
    createdAt: now,
  });
  return store;
}

/** Runs one execution and returns the conversation each agent was sent. */
async function conversations(
  manifests: readonly RuntimeManifest[],
  input: Partial<TurnInput> = {},
  options: {
    narrative?: string;
    maxInputTokens?: number;
    reservedForResponse?: number;
    resolveBudget?: LLMAdapter["resolveBudget"];
  } = {},
) {
  const store = await seedSession();
  const seen = new Map<string, readonly LLMMessage[]>();
  const narrative = options.narrative ?? NARRATIVE;
  const { runtimeResults } = await executeTurn(
    { sessionId: "s", turnId: "t2", playerMessage: "I set it in.", ...input },
    manifests,
    {
      store,
      ...(options.maxInputTokens
        ? {
            contextBudget: {
              maxInputTokens: options.maxInputTokens,
              reservedForResponse: options.reservedForResponse ?? 0,
            },
            estimator: (text: string) => text.length,
          }
        : {}),
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: `PROMPT:${manifest.name}`,
      }),
      llm: {
        ...(options.resolveBudget
          ? { resolveBudget: options.resolveBudget }
          : {}),
        generate: async (request: LLMRequest) => {
          const system = String(request.messages[0]?.content ?? "");
          const name = /PROMPT:([\w-]+)/.exec(system)?.[1] ?? "";
          seen.set(name, request.messages.slice(1));
          return {
            content: name === "narrator" ? narrative : "noted",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    },
  );
  return Object.assign(
    (name: string) =>
      (seen.get(name) ?? []).map(({ role, content }) => `${role}: ${content}`),
    {
      called: (name: string) => seen.has(name),
      result: (name: string) =>
        runtimeResults.find((result) => result.runtimeId === name),
    },
  );
}

const committed = [
  "user: I carry the wick to the stone seat.",
  `assistant: ${PRIOR_NARRATIVE}`,
];

describe("story text of the current execution in the conversation", () => {
  it("ends a post-story agent's conversation on this turn's story", async () => {
    const sent = await conversations([narrator, observer()]);

    expect(sent("narrator")).toEqual([...committed, "user: I set it in."]);
    expect(sent("observer")).toEqual([
      ...committed,
      "user: I set it in.",
      `assistant: ${NARRATIVE}`,
      `user: ${CUE}`,
    ]);
  });

  it("sends the current turn in full to a runtime that keeps no history", async () => {
    const sent = await conversations([
      narrator,
      observer({ history: { maxTurns: 0 } }),
    ]);

    expect(sent("observer")).toEqual([
      "user: I set it in.",
      `assistant: ${NARRATIVE}`,
      `user: ${CUE}`,
    ]);
  });

  it("does not repeat a retried turn's story, which the history already holds", async () => {
    const seed = {
      pluginId: "narrator",
      runtimeId: "narrator",
      runId: "r",
      turnId: "t1",
      status: "success",
      output: { narrativeOutput: PRIOR_NARRATIVE },
      toolCalls: [],
      durationMs: 0,
      timestamp: now,
    } as RuntimeResult;
    // A seed read back from an in-memory store can still carry its journal.
    attachRuntimeJournal(
      seed,
      { origin: "player", sessionId: "s", turnId: "t1", playerMessage: "x" },
      narrator,
      seed.output!,
    );
    const sent = await conversations([narrator, observer()], {
      turnId: "retry",
      playerMessage: "",
      origin: "manual",
      manualTrigger: {
        runtimeId: "observer",
        sourceTurnId: "t1",
        retrySeedResults: [seed],
      },
    });

    expect(sent("observer")).toEqual([
      ...committed,
      "user: Execute the current manually triggered runtime: observer. Follow the output format in the system prompt exactly and produce this runtime's result.",
    ]);
  });

  it("fails a call that cannot hold this turn's story instead of sending it without", async () => {
    // The story is closed by a user-role cue. A budget that protects only the
    // last user message would drop the story, and the call would go out blind.
    const sent = await conversations(
      [narrator, observer()],
      {},
      { narrative: "x".repeat(9_000), maxInputTokens: 8_000 },
    );

    expect(sent.result("narrator")?.status).toBe("success");
    expect(sent.called("observer")).toBe(false);
    expect(sent.result("observer")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Context budget exceeded"),
    });
  });

  it("leaves a fallback budget unchecked until the call's own limits replace it", async () => {
    // The fallback reserve fills the window; only the model's limits make
    // the budget usable, and they apply at each call.
    const sent = await conversations(
      [narrator, observer()],
      {},
      {
        maxInputTokens: 16_384,
        reservedForResponse: 16_384,
        resolveBudget: () => ({
          contextWindow: 16_384,
          maxOutputTokens: 16_384,
          requestedMaxOutputTokens: 4096,
        }),
      },
    );

    expect(sent.result("observer")).toMatchObject({ status: "success" });
    expect(sent("observer").at(-1)).toBe(`user: ${CUE}`);
  });
});
