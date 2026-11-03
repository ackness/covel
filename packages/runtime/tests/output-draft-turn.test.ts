import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { LLMAdapter, LLMStreamEvent, TurnInput } from "@covel/shared";
import { createHookPipeline, executeTurn } from "../src/index.js";
import type { OutputDraftEvent } from "../src/output-draft/draft-forwarder.js";
import {
  makeExecutor,
  manifest,
  markTool,
} from "./_helpers/agent-loop-fixture.js";

const input: TurnInput = {
  origin: "player",
  sessionId: "session",
  turnId: "turn",
  playerMessage: "Go",
  locale: "en-US",
};

async function run(
  responses: readonly (readonly (LLMStreamEvent | Error)[])[],
  overrides: Parameters<typeof manifest>[0] = {},
) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "session",
    locale: "en-US",
    status: "active",
    phase: "playing",
    activePlugins: ["plug"],
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    createdAt: now,
    updatedAt: now,
  });
  const runtime = manifest({
    outputKind: "story",
    maxRetries: 1,
    ...overrides,
  });
  let call = 0;
  const llm: LLMAdapter = {
    generate: async () => {
      throw new Error("stream expected");
    },
    stream: vi.fn(async function* () {
      const script = responses[call++];
      if (!script) throw new Error("unexpected model request");
      for (const event of script) {
        if (event instanceof Error) throw event;
        yield event;
      }
    }),
  };
  const events: OutputDraftEvent[] = [];
  const execution = await executeTurn(input, [runtime], {
    store,
    llm,
    hookPipeline: createHookPipeline(),
    toolExecutor: makeExecutor([markTool]),
    outputDrafts: (event) => events.push(event),
    loadRuntime: async () => ({
      manifest: runtime,
      promptTemplate: "Submit the story.",
    }),
  });
  return { execution, events };
}

/** A submit-output call streamed in small fragments, then completed. */
function submission(args: string, id = "submit"): LLMStreamEvent[] {
  const fragments: LLMStreamEvent[] = [];
  for (let index = 0; index < args.length; index += 5)
    fragments.push({
      type: "tool-argument-delta",
      index: 0,
      id,
      name: "submit-output",
      argumentsDelta: args.slice(index, index + 5),
    });
  return [
    ...fragments,
    { type: "tool-call", id, name: "submit-output", arguments: args },
    {
      type: "done",
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];
}

const shape = (events: readonly OutputDraftEvent[]) =>
  events.map((event) =>
    event.type === "output.retracted"
      ? `${event.type} ${event.payload.reason}`
      : `${event.type} ${event.payload.units.map((unit) => unit.text).join("|")}`,
  );

describe("story drafts in a turn", () => {
  it("shows the story as the model writes it, then accepts it", async () => {
    const { execution, events } = await run([
      submission(JSON.stringify({ narrativeOutput: "Whole story." })),
    ]);
    expect(execution.result.runtimeResults[0]?.status).toBe("success");
    expect(shape(events)).toEqual([
      "output.draft Whole story.",
      "output.accepted Whole story.",
    ]);
    expect(events[0]?.payload).toMatchObject({
      turnId: "turn",
      runtimeId: expect.any(String),
      pluginId: expect.any(String),
      mode: "units",
    });
  });

  it("retracts a rejected submission before the corrected one shows", async () => {
    const { execution, events } = await run([
      // Blank story text fails the story schema.
      submission(JSON.stringify({ narrativeOutput: " " }), "first"),
      submission(JSON.stringify({ narrativeOutput: "Fixed." }), "second"),
    ]);
    expect(execution.result.runtimeResults[0]?.status).toBe("success");
    expect(shape(events)).toEqual([
      "output.draft  ",
      "output.retracted revising",
      "output.draft Fixed.",
      "output.accepted Fixed.",
    ]);
    const [first, , second] = events;
    expect(first?.payload.draftId).not.toBe(second?.payload.draftId);
  });

  it("retracts what a failed run showed", async () => {
    const { execution, events } = await run(
      [
        [
          ...submission(JSON.stringify({ narrativeOutput: "Never." })).slice(
            0,
            // The text has arrived, its closing quote has not.
            5,
          ),
          new Error("not retriable"),
        ],
      ],
      // Text mode shows the unfinished line, so there is something to retract.
      { output: { live: "text" } },
    );
    expect(execution.result.runtimeResults[0]?.status).toBe("failed");
    expect(shape(events).at(-1)).toMatch(/^output\.retracted /);
    expect(events[0]).toMatchObject({
      type: "output.draft",
      payload: { partial: { text: "Never" } },
    });
    expect(shape(events)).not.toContain("output.accepted Never.");
  });

  it("shows nothing for a runtime that turned drafts off", async () => {
    const { events } = await run(
      [submission(JSON.stringify({ narrativeOutput: "Quiet." }))],
      { output: { live: "off" } },
    );
    expect(events).toEqual([]);
  });
});
