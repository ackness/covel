import { describe, expect, it } from "vitest";
import {
  getEmittedEvents,
  getPendingProposals,
  getToolContent,
  shortId,
  tool,
  z,
} from "@covel/tools";
import makeSubmitImagePromptTools from "../tools/submit-image-prompt.js";

const context = {
  sessionId: "session-image-prompt",
  turnId: "turn-image-prompt",
  pluginId: "dashscope-image-gen",
  runtimeId: "dashscope-image-gen/prompt-generator",
};

function toolsByName() {
  return new Map(
    makeSubmitImagePromptTools({ tool, z, shortId }).map((entry) => [
      entry.name,
      entry,
    ]),
  );
}

describe("dashscope image prompt submission tools", () => {
  it("submits text with one fixed event and one persistence proposal", async () => {
    const submit = toolsByName().get("submit-dashscope-text-prompt");
    const result = await submit.execute(
      { prompt: "  cinematic moonlit harbor  ", composition: "single-scene" },
      context,
    );

    expect(getToolContent(result)).toEqual({
      prompt: "cinematic moonlit harbor",
      promptMode: "text",
      composition: "single-scene",
    });
    expect(getEmittedEvents(result)).toEqual([
      {
        topic: "image.generate.requested",
        data: {
          prompt: "cinematic moonlit harbor",
          promptMode: "text",
          composition: "single-scene",
        },
      },
    ]);
    expect(getPendingProposals(result)).toMatchObject([
      {
        type: "plugin.data",
        payload: {
          namespace: "prompts",
          key: "prompt-cinematic-moonlit-harbor",
          value: {
            prompt: "cinematic moonlit harbor",
            promptMode: "text",
            composition: "single-scene",
          },
        },
      },
    ]);
  });

  it("serializes a structured prompt exactly once", async () => {
    const submit = toolsByName().get("submit-dashscope-structured-prompt");
    const prompt = {
      subject: { who: "旅人" },
      quality: ["4K", "masterpiece"],
    };
    const result = await submit.execute(
      { prompt, composition: "comic-strip" },
      context,
    );

    expect(getToolContent(result)).toEqual({
      prompt: JSON.stringify(prompt),
      promptMode: "image-json",
      composition: "comic-strip",
    });
    expect(getEmittedEvents(result)?.[0]?.data.prompt).toBe(
      JSON.stringify(prompt),
    );
  });

  it("rejects an empty structured prompt before emitting an event", async () => {
    const submit = toolsByName().get("submit-dashscope-structured-prompt");

    await expect(
      submit.execute({ prompt: {}, composition: "single-scene" }, context),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: expect.arrayContaining([
        expect.objectContaining({ path: "prompt" }),
      ]),
    });
  });
});
