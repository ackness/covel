import { describe, expect, it } from "vitest";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import { storyOutputJsonSchema, type RuntimeManifest } from "@covel/shared";
import { settleAgentLoop } from "../src/agent-loop/settle-agent-loop.js";
import { STORY_EMPTY_ERROR } from "../src/agent-loop/story-output.js";
import {
  doneTool,
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
const json = (value: unknown) => prose(JSON.stringify(value));
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

describe("segmented story repair", () => {
  it("asks for segments as the response format and accepts a valid story in one call", async () => {
    const llm = queuedLLM([validStory]);
    const { result } = await run({ llm });
    expect(llm.requests).toHaveLength(1);
    const format = llm.requests[0]?.responseFormat;
    expect(format?.type).toBe("json_schema");
    expect(format?.schema).toHaveProperty("properties.segments");
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({
      narrativeOutput: "雨停了。\n\n「走吧。」",
    });
  });

  it("repairs a dialogue without a speaker once, with tools off", async () => {
    const llm = queuedLLM([
      json({ segments: [{ kind: "dialogue", text: "「走吧。」" }] }),
      validStory,
    ]);
    const { result, loop } = await run({ llm });
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.tools).toBeUndefined();
    expect(lastMessage(llm, 1)).toContain(
      "segment 1 is dialogue without a speaker; name who speaks",
    );
    expect(loop.stop).toEqual({ reason: "completed", repaired: true });
    expect(result.stop).toEqual({ reason: "completed", repaired: true });
    expect(result.status).toBe("success");
  });

  it("commits prose as narration once the repair budget is spent", async () => {
    const llm = queuedLLM([
      prose("雨停了。"),
      prose("雨停了。\n\n她转身离开。"),
      validStory,
    ]);
    const { result } = await run({ llm });
    expect(llm.requests).toHaveLength(2);
    expect(lastMessage(llm, 1)).toContain("the answer is prose");
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({
      segments: [
        { kind: "narration", text: "雨停了。" },
        { kind: "narration", text: "她转身离开。" },
      ],
    });
  });

  it("accepts prose without repair from a runtime that asked for no schema", async () => {
    const llm = queuedLLM([prose("雨停了。\n\n她转身离开。")]);
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

  it("keeps an unattributed line when repair is turned off", async () => {
    const llm = queuedLLM([
      json({ segments: [{ kind: "dialogue", text: "「走吧。」" }] }),
    ]);
    const runtime = story({
      loopProfile: { corrections: { outputRepair: 0 } },
    });
    const { result } = await run({ llm, runtime });
    expect(llm.requests).toHaveLength(1);
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({
      segments: [{ kind: "dialogue", text: "「走吧。」" }],
    });
  });

  it("fails with the empty-story error when no text is left after the repair", async () => {
    const empty = json({ segments: [{ kind: "narration", text: " " }] });
    const llm = queuedLLM([empty, empty]);
    const { result } = await run({ llm });
    expect(llm.requests).toHaveLength(2);
    expect(result.status).toBe("failed");
    expect(result.error).toBe(STORY_EMPTY_ERROR);
    expect(result.stop).toEqual({ reason: "invalid-output" });
  });

  it("answers an early runtime-done by asking for the story, not with an authorization error", async () => {
    const llm = queuedLLM([toolCall("runtime-done", {}), validStory]);
    const { result } = await run({
      llm,
      deps: { toolExecutor: makeExecutor([markTool, doneTool]) },
    });
    expect(result.status).toBe("success");
    expect(llm.requests).toHaveLength(2);
    expect(lastMessage(llm, 1)).toContain("have not written the story");
    expect(JSON.stringify(llm.requests[1]?.messages)).not.toMatch(
      /not authorized|not allowed/i,
    );
  });
});
