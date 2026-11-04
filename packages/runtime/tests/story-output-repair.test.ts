import { describe, expect, it } from "vitest";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  storyOutputJsonSchema,
  type LLMAdapter,
  type LLMResponse,
  type RuntimeManifest,
} from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { executeTurn } from "../src/execution.js";
import { commitExecution } from "../src/commit/commit-execution.js";
import { settleAgentLoop } from "../src/agent-loop/settle-agent-loop.js";

import { submissionSyntaxProblems } from "../src/agent-loop/output-format-diagnostics.js";
import {
  input,
  makeExecutor,
  manifest,
  markTool,
  prose,
  queuedLLM,
  runLoop,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const storySchema = storyOutputJsonSchema();
const story = (overrides?: Partial<RuntimeManifest>) =>
  manifest({
    outputKind: "story",
    tools: {},
    output: { schema: "contract:narrative-engine@2" },
    ...overrides,
  } as Partial<RuntimeManifest>);
const segmented: LoadedRuntime = {
  manifest: story(),
  promptTemplate: "Write the story.",
  outputSchema: storySchema,
};
const json = (value: Record<string, unknown>) =>
  toolCall("submit-output", value);
const malformed = (text: string): LLMResponse => ({
  ...json({}),
  toolCalls: [{ id: "malformed", name: "submit-output", arguments: text }],
});
const validStory = json({
  segments: [
    { kind: "narration", text: "雨停了。" },
    { kind: "dialogue", speaker: "阿雅", text: "「走吧。」" },
  ],
});

async function run(opts: {
  llm: ReturnType<typeof queuedLLM>;
  runtime?: RuntimeManifest;
  loaded?: LoadedRuntime;
  deps?: Record<string, unknown>;
}) {
  const runtime = opts.runtime ?? story();
  const loaded = opts.loaded ?? segmented;
  const loop = await runLoop({
    llm: opts.llm,
    manifest: runtime,
    loaded,
    ...(opts.deps ? { deps: opts.deps } : {}),
  });
  return {
    loop,
    ...settleAgentLoop({
      manifest: runtime,
      input,
      runId: "run-loop",
      startTime: Date.now(),
      toolLoop: loop,
      outputSchema: loaded.outputSchema,
    }),
  };
}

const lastMessage = (llm: ReturnType<typeof queuedLLM>, request: number) =>
  String(llm.requests[request]?.messages.at(-1)?.content ?? "");

const completeStory = {
  segments: [{ kind: "narration", text: "Rain falls." }],
  cues: { scene: "Harbor", mood: "tense" },
  yield: "continue",
};
const earlyClosedStory =
  '{"segments":[{"kind":"narration","text":"Rain falls."}]},"cues":{"scene":"Harbor","mood":"tense"},"yield":"continue"}';

function expectSyntaxCorrection(correction: string) {
  expect(correction).toMatch(/JSON syntax/i);
  expect(correction).toMatch(/after.*(?:root|object)/i);
  expect(correction).toMatch(/expect.*end.of.input/i);
  expect(correction).toContain(`offset ${earlyClosedStory.indexOf(',"cues"')}`);
  expect(correction).toContain("UTF-16");
  expect(correction).toMatch(/all fields.*one complete object/i);
  expect(correction).not.toMatch(/missing.*segments|segments.*missing/i);
  expect(correction).not.toContain("No segments");
}

async function commitStory(replies: LLMResponse[], streaming = false) {
  const runtime = story({ tools: { plugin: ["mark"] } });
  const llm = queuedLLM(replies);
  const adapter: LLMAdapter = streaming
    ? {
        ...llm,
        stream: async function* (request) {
          const reply = await llm.generate(request);
          if (reply.content)
            yield { type: "text-delta", textDelta: reply.content };
          for (const call of reply.toolCalls)
            yield { type: "tool-call", ...call };
          yield { type: "done", finishReason: reply.finishReason };
        },
      }
    : llm;
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: input.sessionId,
    locale: "en-US",
    status: "active",
    phase: "playing",
    activePlugins: [runtime.pluginId],
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  const execution = await executeTurn(
    { ...input, logicalTurnId: "logical-story" },
    [runtime],
    {
      store,
      llm: adapter,
      toolExecutor: makeExecutor([markTool]),
      loadRuntime: async () => ({ ...segmented, manifest: runtime }),
    },
  );
  const committed = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
  });
  return { llm, store, committed, result: execution.result.runtimeResults[0] };
}

describe("segmented story repair", () => {
  it.each([false, true])(
    "retains genuine missing-segments diagnostics for valid JSON (streaming: %s)",
    async (streaming) => {
      const { llm, committed } = await commitStory(
        [json({ cues: { scene: "Harbor" } }), json(completeStory)],
        streaming,
      );
      expect(llm.requests).toHaveLength(2);
      expect(lastMessage(llm, 1)).toContain("segments");
      expect(lastMessage(llm, 1)).not.toMatch(/JSON syntax/i);
      expect(committed.status).toBe("committed");
    },
  );

  it.each(["en-US", "zh-CN"])(
    "omits fragment schema complaints from syntax feedback in %s",
    async (locale) => {
      let syntaxError: unknown;
      try {
        JSON.parse(earlyClosedStory);
      } catch (error) {
        syntaxError = error;
      }
      const problems = await submissionSyntaxProblems(syntaxError, locale);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toContain(
        locale === "zh-CN" ? "JSON 语法错误" : "JSON syntax error",
      );
      expect(problems.join(" ")).toContain("UTF-16");
      expect(problems.join(" ")).not.toMatch(/segments|\/cues/);
    },
  );

  it.each([false, true])(
    "explains an early root close and commits the complete replacement (streaming: %s)",
    async (streaming) => {
      const { llm, committed, result, store } = await commitStory(
        [malformed(earlyClosedStory), json(completeStory)],
        streaming,
      );
      expect(llm.requests).toHaveLength(2);
      expectSyntaxCorrection(lastMessage(llm, 1));
      expect(llm.requests[1]?.responseFormat).toEqual(
        llm.requests[0]?.responseFormat,
      );
      expect(
        llm.requests[1]?.tools?.some((tool) => tool.name === "submit-output"),
      ).toBe(true);
      expect(result).toMatchObject({
        status: "success",
        output: completeStory,
      });
      expect(committed.status).toBe("committed");
      const saved = (await store.listMessages(input.sessionId)).filter(
        (message) => message.role === "assistant",
      );
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        content: "Rain falls.",
        metadata: completeStory,
      });
    },
  );

  it("keeps a staged business write uncommitted after repeated early root closes", async () => {
    const { llm, result, committed, store } = await commitStory([
      toolCall("mark", { note: "pending marker" }),
      malformed(earlyClosedStory),
      malformed(earlyClosedStory),
      malformed(earlyClosedStory),
      malformed(earlyClosedStory),
    ]);
    expect(llm.requests).toHaveLength(5);
    expect(result?.toolCalls).toContainEqual(
      expect.objectContaining({
        toolName: "mark",
        output: { _text: "marked:pending marker" },
      }),
    );
    expect(
      result?.toolCalls.filter((call) => call.toolName === "mark"),
    ).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failed",
      output: null,
      stop: { reason: "invalid-output" },
    });
    expect(committed.status).toBe("failed");
    expect(await store.listPluginData(input.sessionId, "plug", "loop")).toEqual(
      [],
    );
    expect(await store.listMessages(input.sessionId)).toEqual([]);
    expect(
      (await store.getSession(input.sessionId))?.completedPlayerTurns,
    ).toBe(0);
    expect(
      llm.requests[4]?.tools?.some((tool) => tool.name === "submit-output"),
    ).toBe(true);
    expect(
      llm.requests[4]?.messages.flatMap((message) => message.toolCalls ?? []),
    ).toHaveLength(4); // Prior work and the rejected submissions remain correlated.
    expectSyntaxCorrection(lastMessage(llm, 4));
  });

  it.each([null, "", " \n\t "])(
    "explains that a blank answer returned no JSON (%j)",
    async (content) => {
      const llm = queuedLLM([{ ...prose(""), content }, validStory]);
      const { result } = await run({ llm });
      expect(llm.requests).toHaveLength(2);
      expect(result.status).toBe("success");
      expect(lastMessage(llm, 1)).toContain("submit-output");
    },
  );

  it("advertises segments in the submission schema and accepts a valid story in one call", async () => {
    const llm = queuedLLM([validStory]);
    const { result } = await run({ llm });
    expect(llm.requests).toHaveLength(1);
    const format = llm.requests[0]?.responseFormat;
    expect(format).toBeUndefined();
    expect(
      llm.requests[0]?.tools?.find((tool) => tool.name === "submit-output")
        ?.parameters,
    ).toHaveProperty("properties.segments");
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({
      narrativeOutput: "雨停了。\n\n「走吧。」",
    });
  });

  it("repairs a dialogue without a speaker once, in the ordinary loop", async () => {
    const llm = queuedLLM([
      json({ segments: [{ kind: "dialogue", text: "「走吧。」" }] }),
      validStory,
    ]);
    const { result, loop } = await run({ llm });
    expect(llm.requests).toHaveLength(2);
    expect(
      llm.requests[1]?.tools?.some((tool) => tool.name === "submit-output"),
    ).toBe(true);
    expect(lastMessage(llm, 1)).toContain(
      "segment 1 is dialogue without a speaker; name who speaks",
    );
    expect(loop.stop).toEqual({ reason: "completed" });
    expect(result.stop).toEqual({ reason: "completed" });
    expect(result.status).toBe("success");
  });

  it("fails content-only prose after the missing-submission budget is spent", async () => {
    const llm = queuedLLM([
      prose("雨停了。"),
      prose("她转身离开。"),
      prose("灯灭了。"),
      prose("风停了。"),
      validStory,
    ]);
    const { result } = await run({ llm });
    expect(llm.requests).toHaveLength(4);
    expect(result.status).toBe("failed");
    expect(result.output).toBeNull();
  });

  it("recovers from prose followed by cut-off submission JSON within the story budget", async () => {
    // A provider answered with plain prose, then cut the corrected
    // submission off at its "yield" key. Both are output repairs.
    const llm = queuedLLM([
      prose("雨停了。"),
      malformed('{"segments":[{"kind":"narration","text":"雨停了。"}],"yield"'),
      validStory,
    ]);
    const { result, loop } = await run({ llm });
    expect(llm.requests).toHaveLength(3);
    expect(lastMessage(llm, 2)).toContain("JSON");
    expect(loop.stop).toEqual({ reason: "completed" });
    expect(result.status).toBe("success");
  });

  it("accepts submitted narrativeOutput from a runtime with the host default schema", async () => {
    const llm = queuedLLM([
      json({ narrativeOutput: "雨停了。\n\n她转身离开。" }),
    ]);
    const runtime = story({ output: undefined });
    const { result } = await run({
      llm,
      runtime,
      loaded: { manifest: runtime, promptTemplate: "Write the story." },
    });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.responseFormat).toBeUndefined();
    expect(result.output).toMatchObject({
      segments: [
        { kind: "narration", text: "雨停了。" },
        { kind: "narration", text: "她转身离开。" },
      ],
    });
  });

  it("rejects an unattributed line when repair is turned off", async () => {
    const llm = queuedLLM([
      json({ segments: [{ kind: "dialogue", text: "「走吧。」" }] }),
    ]);
    const runtime = story({
      loopProfile: { corrections: { outputRepair: 0 } },
    });
    const { result } = await run({ llm, runtime });
    expect(llm.requests).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(result.output).toBeNull();
  });

  it("fails with the empty-story error when no text is left after the repair", async () => {
    const empty = json({ segments: [{ kind: "narration", text: " " }] });
    const llm = queuedLLM([empty, empty, empty, empty]);
    const { result } = await run({ llm });
    expect(llm.requests).toHaveLength(4);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("invalid-output");
    expect(result.stop).toEqual({ reason: "invalid-output" });
  });

  it("rejects an empty submitted story before accepting the next candidate", async () => {
    const llm = queuedLLM([json({ segments: [] }), validStory]);
    const { result } = await run({ llm });
    expect(result.status).toBe("success");
    expect(llm.requests).toHaveLength(2);
    expect(lastMessage(llm, 1)).toContain("invalid-output");
  });
});
