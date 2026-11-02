import { describe, expect, it } from "vitest";
import type { LLMToolDefinition, RuntimeManifest } from "@covel/shared";
import { requestDefaults } from "../src/agent-loop/tool-loop-handler.js";

const manifest: RuntimeManifest = {
  name: "example/extract",
  pluginId: "example",
  description: "Extract facts",
  runtimeType: "agent",
  outputKind: "system",
  trigger: { type: "manual" },
  llm: { toolChoice: { name: "save-facts" }, reasoningEffort: "disabled" },
};
const tools: LLMToolDefinition[] = ["save-facts", "submit-output"].map(
  (name) => ({ name, description: name, parameters: { type: "object" } }),
);

describe("submission request defaults", () => {
  it("preserves authored business choice during ordinary work", () => {
    expect(requestDefaults(manifest, false, tools)).toEqual(manifest.llm);
  });
  it("lets a correction select submission after a named business default", () => {
    expect(requestDefaults(manifest, true, tools, undefined, true)).toEqual({
      reasoningEffort: "disabled",
      toolChoice: { name: "submit-output" },
    });
    expect(
      requestDefaults(manifest, true, tools, "auto", true)?.toolChoice,
    ).toEqual({
      name: "submit-output",
    });
  });
  it("selects submission on the finalizer surface without changing reasoning", () => {
    expect(requestDefaults(manifest, false, [tools[1]!])).toEqual({
      reasoningEffort: "disabled",
      toolChoice: { name: "submit-output" },
    });
    expect(
      requestDefaults({ ...manifest, llm: undefined }, true, tools)
        ?.reasoningEffort,
    ).toBeUndefined();
  });
  it("preserves hook choice and ordinary tool correction when submission is absent", () => {
    expect(requestDefaults(manifest, true, tools)).toEqual(manifest.llm);
    expect(
      requestDefaults(manifest, false, tools, { name: "save-facts" }),
    ).toEqual(manifest.llm);
    expect(
      requestDefaults({ ...manifest, llm: undefined }, true, [tools[0]!]),
    ).toEqual({ toolChoice: "required" });
  });
});
