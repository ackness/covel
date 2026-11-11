import { storySubmitted, toolCall } from "./_helpers/agent-loop-fixture.js";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { tool } from "@covel/tools";
import { z } from "zod";
import {
  promptHistoryTransformV1,
  sessionWorldContextV1,
  type RuntimeManifest,
  type RuntimeResult,
} from "@covel/shared";
import type { LLMAdapter, LLMResponse } from "@covel/shared";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import {
  executeTurn as executePreparedTurn,
  type ExecutionDeps,
} from "../src/execution.js";
import {
  commitExecution,
  refuseReleasedJobs,
} from "../src/commit/commit-execution.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { collectExecutionJournal } from "../src/execution-journal.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { finalizeAgentOutput } from "../src/agent-loop/finalize-agent-output.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";

const manifest: RuntimeManifest = {
  name: "story-test",
  pluginId: "story-test",
  description: "Narrate a turn after reading the scene",
  stage: "narrative",
  outputKind: "story",
  tools: { builtin: ["read-scene"] },
};
const lookup = tool({
  name: "read-scene",
  description: "Read the scene",
  parameters: z.object({}),
  execute: async () => ({ scene: "A lamp lights the stairs." }),
});
function response(content: string | null, name?: string): LLMResponse {
  return {
    content,
    toolCalls: name ? [{ id: crypto.randomUUID(), name, arguments: "{}" }] : [],
    finishReason: name ? "tool_calls" : "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
async function run(
  script: LLMResponse[],
  options: { emptyAfterHook?: boolean; failedExtractor?: boolean } = {},
) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    locale: "en-US",
    id: "session-story",
    worldId: "world-story",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [manifest.pluginId],
    createdAt: now,
    updatedAt: now,
  });
  const requests: Parameters<LLMAdapter["generate"]>[0][] = [];
  const hooks = createHookPipeline();
  if (options.emptyAfterHook)
    hooks.register({
      id: "erase-story",
      event: "PostRuntime",
      handler: async (_ctx, payload) => ({
        action: "continue",
        replace: {
          result: {
            ...(payload as { result: RuntimeResult }).result,
            output: { narrativeOutput: " " },
          },
        },
      }),
    });
  const result = await runTurnPipeline(
    {
      sessionId: "session-story",
      turnId: "turn-story",
      playerMessage: "Walk upstairs.",
      origin: "player",
    },
    [manifest],
    {
      store,
      hookPipeline: hooks,
      loadRuntime: async () => ({
        manifest,
        promptTemplate: "Write the story.",
      }),
      llm: {
        generate: async (request) => {
          const next = script[Math.min(requests.length, script.length - 1)]!;
          requests.push({ ...request, messages: [...request.messages] });
          return next;
        },
      },
      toolExecutor: createToolExecutor({
        store,
        findTool: (name) => (name === lookup.name ? lookup : undefined),
      }),
    },
    { maxSteps: 3 },
  );
  const committed = await finalizeExecution({
    store,
    sessionId: "session-story",
    runtimes: [
      manifest,
      {
        ...manifest,
        name: "extractor",
        pluginId: "extractor",
        outputKind: "system",
      },
    ],
    results: [
      ...result.runtimeResults,
      ...(options.failedExtractor
        ? [
            {
              pluginId: "extractor",
              runtimeId: "extractor",
              runId: "extractor-run",
              turnId: "turn-story",
              status: "failed" as const,
              output: null,
              toolCalls: [],
            },
          ]
        : []),
    ],
    executionContext: {
      executionId: "turn-story",
      origin: "player",
      countPolicy: "complete-player-turn",
      logicalTurnId: "logical-story",
    },
    turnIds: ["turn-story"],
    sessionClock: { now },
    journalMessages: collectExecutionJournal(result),
  });
  return { store, result, requests, committed };
}

describe("story completion contract", () => {
  it("rejects a hook that removes completed prose without committing the action", async () => {
    const { result, committed, store } = await run(
      [storySubmitted("A lamp lights the stairs.")],
      { emptyAfterHook: true },
    );
    expect(result.runtimeResults[0]?.status).toBe("failed");
    expect(committed.status).toBe("failed");
    expect(
      (await store.getSession("session-story"))?.completedPlayerTurns,
    ).toBe(0);
  });
  it("commits a valid story when an optional system extractor fails", async () => {
    const { committed, store } = await run(
      [storySubmitted("A lamp lights the stairs.")],
      { failedExtractor: true },
    );
    expect(committed.status).toBe("committed");
    expect(
      (await store.getSession("session-story"))?.completedPlayerTurns,
    ).toBe(1);
  });
  it("does not offer runtime-done to a story runtime", async () => {
    // Only the generated submission control can finish this agent.
    const { requests, result } = await run([
      storySubmitted("You climb the lit stairs."),
    ]);
    expect(requests[0]?.tools?.map((offered) => offered.name)).toEqual([
      "read-scene",
      "submit-output",
    ]);
    expect(result.runtimeResults[0]?.status).toBe("success");
  });

  it("requires a valid submission and commits the corrected story once", async () => {
    const { result, requests, committed, store } = await run([
      response(null, "read-scene"),
      toolCall("submit-output", {
        segments: [{ kind: "narration", text: " " }],
      }),
      storySubmitted("You climb the lit stairs."),
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.tools?.map((tool) => tool.name)).toContain(
      "submit-output",
    );
    expect(result.runtimeResults[0]).toMatchObject({
      status: "success",
      output: { narrativeOutput: "You climb the lit stairs." },
    });
    expect(committed.status).toBe("committed");
    expect(
      (await store.getSession("session-story"))?.completedPlayerTurns,
    ).toBe(1);
    expect(
      (await store.listMessages("session-story")).filter(
        (message) => message.role === "assistant",
      ),
    ).toHaveLength(1);
  });

  it.each([null, "   ", '{"toolCalls":[]}'])(
    "rejects empty story %j without committing or counting the action",
    async (content) => {
      const { result, committed, store } = await run([
        response(null, "read-scene"),
        response(null, "runtime-done"),
        response(content),
      ]);
      expect(result.runtimeResults[0]?.status).toBe("failed");
      expect(committed.status).toBe("failed");
      expect(
        (await store.getSession("session-story"))?.completedPlayerTurns,
      ).toBe(0);
      expect(await store.listMessages("session-story")).toHaveLength(0);
      expect(await store.listTurnMessages("session-story")).toHaveLength(0);
    },
  );

  async function failedProviderTurn(story: RuntimeManifest) {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    const runtimes = [
      {
        name: "dimensions/context",
        pluginId: "dimensions",
        runtimeType: "function",
        outputContract: "world.dimensions@1",
        stage: "pre-turn",
        outputKind: "system",
        trigger: { type: "auto" },
      },
      {
        name: "planner",
        pluginId: "planner",
        runtimeType: "function",
        stage: "pre-turn",
        outputKind: "system",
        trigger: { type: "auto" },
      },
      { ...story, trigger: { type: "auto" } },
    ] as RuntimeManifest[];
    await store.createSession({
      locale: "en-US",
      id: "session-story",
      worldId: "world-story",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: runtimes.map((runtime) => runtime.pluginId),
      createdAt: now,
      updatedAt: now,
    });
    let modelCalls = 0;
    const frozenDimensions = {
      dimensionProviderPluginId: "dimensions",
      dimensions: {},
    };
    const execution = await executePreparedTurn(
      {
        sessionId: "session-story",
        turnId: "turn-story",
        logicalTurnId: "logical-turn-story",
        playerMessage: "Walk upstairs.",
        origin: "player",
      },
      runtimes,
      {
        store,
        // The provider's extension publishes a snapshot; only its runtime fails.
        dimensionContext: frozenDimensions,
        extensionExecution: {
          run: async (point: unknown, input: { messages?: unknown }) =>
            point === sessionWorldContextV1
              ? frozenDimensions
              : point === promptHistoryTransformV1
                ? { messages: input.messages }
                : [],
        } as unknown as ExecutionDeps["extensionExecution"],
        llm: {
          generate: async () => {
            modelCalls += 1;
            return storySubmitted("A lamp lights the stairs.");
          },
        },
        loadRuntime: async (loaded) => ({
          manifest: loaded,
          promptTemplate: "",
          handler: async () =>
            loaded.pluginId === "dimensions"
              ? { outcome: "failed", error: "Snapshot unavailable" }
              : {
                  outcome: "success",
                  value: {},
                  effects: {
                    pluginData: [
                      { namespace: "plan", key: "revealed", value: true },
                    ],
                  },
                },
        }),
      },
    );
    const committed = await commitExecution({
      enqueueReleasedJobsInTx: refuseReleasedJobs,
      store,
      execution,
      completion: { kind: "turn", turnId: "turn-story", durationMs: 0 },
    });
    return {
      store,
      committed,
      modelCalls,
      resultOf: (runtimeId: string) =>
        execution.result.runtimeResults.find(
          (result) => result.runtimeId === runtimeId,
        ),
      revealed: async () =>
        (
          await store.getPluginData(
            "session-story",
            "planner",
            "plan",
            "revealed",
          )
        )?.value,
      turns: async () =>
        (await store.getSession("session-story"))?.completedPlayerTurns,
    };
  }

  it("tells and commits the story when the dimension provider fails, with dimensions paused for the turn", async () => {
    const turn = await failedProviderTurn(manifest);
    // The provider's failure is its own: the story still runs, on the
    // committed values every runtime of the execution already reads.
    expect(turn.resultOf("dimensions/context")).toMatchObject({
      status: "failed",
      error: "Snapshot unavailable",
    });
    expect(turn.resultOf(manifest.name)).toMatchObject({ status: "success" });
    expect(turn.modelCalls).toBe(1);
    expect(turn.committed.status).toBe("committed");
    expect(await turn.turns()).toBe(1);
    expect(await turn.revealed()).toBe(true);
    expect(
      (await turn.store.listMessages("session-story")).filter(
        (message) => message.role === "assistant",
      ),
    ).toHaveLength(1);
  });

  it("refuses the action when the story requires the dimensions from the failed provider", async () => {
    // Binding `world.dimensions@1` as a required input is a hard dependency.
    const turn = await failedProviderTurn({
      ...manifest,
      inputs: { dimensions: { from: { capability: "world.dimensions@1" } } },
    });
    expect(turn.resultOf(manifest.name)).toMatchObject({
      status: "skipped",
      output: {
        skippedBy: "framework:inputBinding",
        failedUpstream: "dimensions/context",
      },
    });
    expect(turn.modelCalls).toBe(0);
    expect(turn.committed.status).toBe("failed");
    expect(turn.committed.error).toContain("because dimensions/context failed");
    expect(await turn.turns()).toBe(0);
    expect(await turn.revealed()).toBeUndefined();
  });

  it("rejects story envelopes without prose while leaving system tool output valid", () => {
    const params = {
      manifest,
      acceptedOutput: { toolCalls: [] },
      executedToolCalls: [],
      pendingProposals: [],
    };
    expect(finalizeAgentOutput(params)).toMatchObject({
      kind: "invalid-output",
    });
    expect(
      finalizeAgentOutput({
        ...params,
        manifest: { ...manifest, outputKind: "system" },
      }),
    ).toMatchObject({ kind: "ok" });
  });

  it.each([null, { error: "Invalid field" }])(
    "does not extract business effects from failed tools (%j)",
    (toolResult) => {
      expect(
        finalizeAgentOutput({
          manifest: { ...manifest, outputKind: "system" },
          acceptedOutput: {},
          executedToolCalls: [
            {
              name: "create-form",
              arguments: "{}",
              success: false,
              result: toolResult,
            },
          ],
          pendingProposals: [],
        }),
      ).toEqual({ kind: "ok", output: {} });
    },
  );
});
