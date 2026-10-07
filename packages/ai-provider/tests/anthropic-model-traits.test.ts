import { describe, expect, it } from "vitest";
import { anthropicModelTraits } from "../src/anthropic-model-traits.js";
import { resolveReasoningEffortProfile } from "../src/reasoning-effort.js";

// The rows are the per-model rules of Anthropic's API reference.
const MODELS = [
  { model: "claude-fable-5-1", forced: false, disable: false },
  { model: "claude-mythos-5-1", forced: false, disable: false },
  { model: "claude-fable-5", forced: true, disable: false },
  { model: "claude-opus-5-5", forced: false, disable: false },
  { model: "claude-sonnet-5-5", forced: false, disable: false },
  { model: "claude-opus-5", forced: true, disable: true },
  { model: "claude-sonnet-5", forced: true, disable: true },
  { model: "claude-opus-4-8", forced: true, disable: true },
  { model: "claude-sonnet-4-6", forced: true, disable: true },
  { model: "anthropic/claude-opus-5.5", forced: false, disable: false },
] as const;

describe("Claude model traits", () => {
  it.each(MODELS)(
    "$model: forced tool choice $forced, thinking can be disabled $disable",
    ({ model, forced, disable }) => {
      expect(anthropicModelTraits(model)).toEqual({
        forcedToolChoice: forced,
        thinkingCanBeDisabled: disable,
      });
    },
  );

  it.each(MODELS)(
    "$model offers `disabled` reasoning only when the model accepts it",
    ({ model, disable }) => {
      const values = resolveReasoningEffortProfile(model)?.options.map(
        (option) => option.value,
      );
      expect(values?.includes("disabled")).toBe(disable);
    },
  );
});
