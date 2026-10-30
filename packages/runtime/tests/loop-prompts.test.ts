import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "@covel/tools";
import {
  answerWithoutTools,
  finalAnswerWithoutTools,
  writeStoryWithoutTools,
} from "../src/agent-loop/loop-prompts.js";
import {
  doneTool,
  makeExecutor,
  manifest,
  prose,
  queuedLLM,
  runLoop,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

afterEach(() => vi.unstubAllEnvs());

const oldStory = {
  en: "You completed tool calls but have not written the story. Write this turn's narrative now using the information already retrieved. Do not call more tools or describe the processing steps.",
  zh: "你只完成了工具调用，还没有输出故事正文。现在根据已读取的信息直接写出本回合正文；不要再调用工具或解释处理过程。",
};
const oldFinal = {
  en: "No steps are left and tools are off. Give your final answer now from the information you already have, in the required output format. Do not call tools or describe the processing steps.",
  zh: "已经没有剩余步数，工具已关闭。现在根据已有的信息直接给出最终答案，按要求的输出格式回复；不要再调用工具或解释处理过程。",
};

describe("tools-off answer prompts", () => {
  it.each(["en", "zh"] as const)(
    "preserves prose and non-story prompts in %s",
    (locale) => {
      vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "auto");
      expect(writeStoryWithoutTools(locale, { segments: false })).toEqual({
        role: "system",
        content: oldStory[locale],
      });
      expect(finalAnswerWithoutTools(locale)).toEqual({
        role: "system",
        content: oldFinal[locale],
      });
      expect(answerWithoutTools("answer", locale, { segments: true })).toEqual(
        finalAnswerWithoutTools(locale),
      );
    },
  );

  it.each(["en", "zh"])(
    "asks for paragraphs, kinds, and dialogue speakers in %s",
    (locale) => {
      vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "auto");
      const prompt = writeStoryWithoutTools(locale, { segments: true });
      for (const field of [
        "JSON",
        "segments",
        "kind",
        "narration",
        "dialogue",
        "action",
        "speaker",
      ])
        expect(prompt.content).toContain(field);
      expect(prompt.content).not.toMatch(/\b[\w.-]+@\d+\b/);
      expect(answerWithoutTools("story", locale, { segments: true })).toEqual(
        prompt,
      );
    },
  );

  it("uses the configured instruction language over the session language", () => {
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "zh");
    expect(writeStoryWithoutTools("en", { segments: true }).content).toContain(
      "每段一项",
    );
    expect(writeStoryWithoutTools("en", { segments: false }).content).toBe(
      oldStory.zh,
    );
    expect(finalAnswerWithoutTools("en").content).toBe(oldFinal.zh);
  });
});

describe("story prompts during the loop", () => {
  it.each([true, false])(
    "uses the schema after lookup-only completion (segments: %s)",
    async (segments) => {
      const lookup = tool({
        name: "lookup",
        description: "lookup",
        parameters: z.object({}),
        execute: async () => ({ found: true }),
      });
      const runtime = manifest({
        outputKind: "story",
        tools: { plugin: ["lookup"], builtin: ["runtime-done"] },
      });
      const response = toolCall("lookup", {}, "lookup-call");
      const llm = queuedLLM([
        {
          ...response,
          toolCalls: [
            ...response.toolCalls,
            ...toolCall("runtime-done", {}, "done-call").toolCalls,
          ],
        },
        prose(
          segments
            ? '{"segments":[{"kind":"narration","text":"The door opens."}],"yield":"user"}'
            : "The door opens.",
        ),
      ]);
      await runLoop({
        llm,
        manifest: runtime,
        loaded: {
          manifest: runtime,
          promptTemplate: "Write.",
          ...(segments
            ? { outputSchema: { properties: { segments: { type: "array" } } } }
            : {}),
        },
        deps: { toolExecutor: makeExecutor([lookup, doneTool]) },
      });
      expect(llm.requests).toHaveLength(2);
      expect(llm.requests[1]!.messages.at(-1)).toEqual(
        writeStoryWithoutTools(undefined, { segments }),
      );
    },
  );

  it.each(["step limit", "loop detection"])(
    "asks for segments after %s",
    async (exit) => {
      const lookup = tool({
        name: "lookup",
        description: "lookup",
        parameters: z.object({}),
        execute: async () => ({ found: true }),
      });
      const runtime = manifest({
        outputKind: "story",
        tools: { plugin: ["lookup"] },
        loopDetectionThreshold: 2,
      });
      const llm = queuedLLM([
        toolCall("lookup", {}, "first"),
        ...(exit === "loop detection"
          ? [toolCall("lookup", {}, "second"), toolCall("lookup", {}, "third")]
          : []),
        prose(
          '{"segments":[{"kind":"narration","text":"The door opens."}],"yield":"user"}',
        ),
      ]);
      await runLoop({
        llm,
        manifest: runtime,
        maxSteps: exit === "step limit" ? 1 : 5,
        loaded: {
          manifest: runtime,
          promptTemplate: "Write.",
          outputSchema: { properties: { segments: { type: "array" } } },
        },
        deps: { toolExecutor: makeExecutor([lookup]) },
      });
      expect(llm.requests.at(-1)!.messages.at(-1)).toEqual(
        writeStoryWithoutTools(undefined, { segments: true }),
      );
    },
  );
});
