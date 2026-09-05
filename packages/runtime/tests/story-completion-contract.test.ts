import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import { runtimeDoneTool, tool } from "@covel/tools";
import { z } from "zod";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
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
    id: "session-story",
    worldId: "world-story",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
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
  const result = await executeTurn(
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
        findTool: (name) =>
          name === lookup.name
            ? lookup
            : name === "runtime-done"
              ? runtimeDoneTool
              : undefined,
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
              status: "failed",
              output: null,
              toolCalls: [],
              durationMs: 1,
              timestamp: now,
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
      [response("A lamp lights the stairs.")],
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
      [response("A lamp lights the stairs.")],
      { failedExtractor: true },
    );
    expect(committed.status).toBe("committed");
    expect(
      (await store.getSession("session-story"))?.completedPlayerTurns,
    ).toBe(1);
  });
  it("requires prose after runtime-done and commits the recovered story once", async () => {
    const { result, requests, committed, store } = await run([
      response(null, "read-scene"),
      response(null, "runtime-done"),
      response("You climb the lit stairs."),
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.tools).toBeUndefined();
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

  it("rejects story envelopes without prose while leaving system tool output valid", () => {
    const params = {
      manifest,
      finalContent: '{"toolCalls":[]}',
      executedToolCalls: [],
      failedToolCalls: [],
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
});
