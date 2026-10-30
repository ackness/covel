import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  storyOutputJsonSchema,
  type LLMAdapter,
  type RuntimeManifest,
  type RuntimeResult,
} from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { STORY_EMPTY_ERROR } from "../src/agent-loop/story-output.js";

const turn = {
  sessionId: "sess-story-fn",
  turnId: "turn-story-fn",
  playerMessage: "开门",
  origin: "player" as const,
};
const teller: RuntimeManifest = {
  name: "teller",
  pluginId: "teller",
  description: "tells the story",
  stage: "narrative",
  runtimeType: "function",
  outputKind: "story",
  outputContract: "narrative-engine@2",
  trigger: { type: "auto" },
};
const listener: RuntimeManifest = {
  name: "listener",
  pluginId: "listener",
  description: "reads the story text",
  stage: "post-turn",
  runtimeType: "function",
  outputKind: "system",
  trigger: { type: "auto" },
  inputs: {
    story: {
      from: { capability: "narrative-engine@2" },
      select: "/narrativeOutput",
    },
  },
};
const written = {
  segments: [
    { kind: "narration", text: "雨停了。" },
    { kind: "dialogue", speaker: "阿雅", text: "「走吧。」" },
  ],
} as const;
const noModel: LLMAdapter = {
  generate: async () => {
    throw new Error("no model needed");
  },
};

async function runFunctions(
  runtimes: readonly RuntimeManifest[],
  handlers: Record<string, FunctionHandler>,
  deps: Partial<TurnExecutorDeps> = {},
): Promise<readonly RuntimeResult[]> {
  const turnResult = await runTurnPipeline(turn, runtimes, {
    store: createMemoryStore(),
    llm: noModel,
    loadRuntime: async (manifest) => ({
      manifest,
      promptTemplate: "",
      handler: handlers[manifest.name],
    }),
    ...deps,
  });
  return turnResult.runtimeResults;
}

describe("function and guard stories", () => {
  it("publishes the joined text to a consumer that selects /narrativeOutput", async () => {
    let received: unknown;
    const results = await runFunctions([teller, listener], {
      teller: async () => ({ outcome: "success", value: written }),
      listener: async (ctx) => {
        const slot = ctx.inputs?.story;
        received = slot?.cardinality === "one" ? slot.value : undefined;
        return { outcome: "success", value: {} };
      },
    });
    expect(results.find((r) => r.runtimeId === "teller")).toMatchObject({
      status: "success",
      output: { narrativeOutput: "雨停了。\n\n「走吧。」", yield: "user" },
      canonicalValue: { value: { narrativeOutput: "雨停了。\n\n「走吧。」" } },
    });
    expect(received).toBe("雨停了。\n\n「走吧。」");
  });

  it("fails a story that a PostRuntime hook empties", async () => {
    const hooks = createHookPipeline();
    hooks.register({
      id: "empty-story",
      event: "PostRuntime",
      handler: async (_ctx, payload) => ({
        action: "continue",
        replace: {
          result: {
            ...(payload as { result: RuntimeResult }).result,
            output: { segments: [] },
          },
        },
      }),
    });
    const [result] = await runFunctions(
      [teller],
      { teller: async () => ({ outcome: "success", value: written }) },
      { hookPipeline: hooks },
    );
    expect(result).toMatchObject({
      status: "failed",
      error: STORY_EMPTY_ERROR,
    });
  });

  it("keeps a guard-provided story skipped and adds its derived text", async () => {
    const agent: RuntimeManifest = {
      ...teller,
      runtimeType: "agent",
      outputContract: undefined,
    };
    const result = (
      await runTurnPipeline(turn, [agent], {
        store: createMemoryStore(),
        llm: noModel,
        loadRuntime: async () => ({
          manifest: agent,
          promptTemplate: "",
          guard: async () => ({ skip: true, ...written }),
        }),
      })
    ).runtimeResults[0];
    expect(result).toMatchObject({
      status: "skipped",
      output: {
        skip: true,
        segments: written.segments,
        narrativeOutput: "雨停了。\n\n「走吧。」",
      },
    });
  });

  it("streams only the segment text of an agent's JSON story", async () => {
    const agent: RuntimeManifest = {
      ...teller,
      runtimeType: "agent",
      outputContract: undefined,
      output: { schema: "contract:narrative-engine@2" },
    } as RuntimeManifest;
    const answer = JSON.stringify({
      ...written,
      cues: { present: ["阿雅"], scene: "旧港" },
    });
    const chunks = answer.match(/.{1,7}/gsu) ?? [];
    const deltas: { textDelta: string; reset?: true }[] = [];
    const result = (
      await runTurnPipeline(turn, [agent], {
        store: createMemoryStore(),
        llm: {
          generate: async () => {
            throw new Error("streaming expected");
          },
          stream: async function* () {
            for (const textDelta of chunks)
              yield { type: "text-delta" as const, textDelta };
            yield { type: "done" as const, finishReason: "stop" as const };
          },
        },
        onDelta: async (delta) => {
          deltas.push({
            textDelta: delta.textDelta,
            ...(delta.reset ? { reset: true as const } : {}),
          });
        },
        loadRuntime: async () => ({
          manifest: agent,
          promptTemplate: "Write the story.",
          outputSchema: storyOutputJsonSchema(),
        }),
      })
    ).runtimeResults[0];
    expect(result?.status).toBe("success");
    const shown = deltas.map((delta) => delta.textDelta).join("");
    expect(shown).toBe("雨停了。\n\n「走吧。」");
    expect(shown).toBe(
      (result!.output as { narrativeOutput: string }).narrativeOutput,
    );
    expect(shown).not.toContain('阿雅"');
    expect(shown).not.toContain("旧港");
  });
});
