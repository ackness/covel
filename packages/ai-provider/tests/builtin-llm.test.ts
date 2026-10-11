import { describe, expect, it } from "vitest";
import { builtinLlmToml, parseLlmConfig } from "../src/index.js";

const storySlot = (text: string) => parseLlmConfig(text).llmConfig.covel.story;

describe("builtinLlmToml", () => {
  it("is a DeepSeek story slot without settings", () => {
    expect(storySlot(builtinLlmToml())).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
    });
  });

  it("points at DEFAULT_BASE_URL with the default provider", () => {
    expect(
      storySlot(
        builtinLlmToml({
          baseUrl: "https://llm.example.com/v1",
          model: "some-model",
        }),
      ),
    ).toMatchObject({
      provider: "default",
      model: "some-model",
      baseUrl: "https://llm.example.com/v1",
    });
  });
});
