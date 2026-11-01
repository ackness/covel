import { describe, expect, it } from "vitest";
import { submitOutputPrompt } from "../src/agent-loop/loop-prompts.js";
describe("submission instruction", () => {
  it.each(["en-US", "zh-CN"])("asks for the same tool in %s", (locale) => {
    expect(submitOutputPrompt(locale).content).toContain("submit-output");
    expect(submitOutputPrompt(locale).role).toBe("system");
  });
});
