import { afterEach, describe, expect, it } from "vitest";

import { setReasoningModelOverrides } from "../src/capability/reasoning-models.js";
import { extractReasoningRequestFields } from "../src/protocol-registry.js";
import { resolveReasoningEffortProfile } from "../src/reasoning-effort.js";
import type { ModelRequestContext } from "../src/types.js";

function sent(model: string, level: string, provider = "custom") {
  return extractReasoningRequestFields(
    { reasoningEffort: level },
    {
      profile: { provider, model } as ModelRequestContext["profile"],
      preset: null,
      mode: "text",
    },
    "openai-chat-v1",
    model,
  );
}

const levels = (model: string, provider?: string, protocol?: string) =>
  resolveReasoningEffortProfile(model, provider, protocol)?.options.map(
    (option) => option.value,
  );

describe("reasoning model overrides", () => {
  afterEach(() => {
    setReasoningModelOverrides(null);
  });

  it("gives a model the bundled data does not name its levels", () => {
    expect(levels("kimi-k3")).toBeUndefined();
    // With no entry, a model of no named family takes any level as selected.
    expect(sent("kimi-k3", "medium")).toEqual({ reasoning_effort: "medium" });

    setReasoningModelOverrides({
      families: [
        {
          id: "compatible",
          rules: [{ match: "kimi-k3", levels: ["low", "high", "max"] }],
        },
      ],
    });

    expect(levels("moonshot/Kimi-K3")).toEqual(["low", "high", "max"]);
    expect(sent("kimi-k3", "max")).toEqual({ reasoning_effort: "max" });
    expect(sent("kimi-k3", "medium")).toEqual({});
    expect(sent("glm-5.2", "medium")).toEqual({ reasoning_effort: "medium" });
  });

  it("reads an override before the bundled rules of the same family", () => {
    expect(levels("gpt-5.9-nova")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);

    setReasoningModelOverrides({
      families: [
        {
          id: "openai",
          rules: [
            { match: "gpt-5\\.9-nova", default: "low", levels: ["low", "max"] },
          ],
        },
      ],
    });

    expect(levels("gpt-5.9-nova")).toEqual(["low", "max"]);
    expect(sent("gpt-5.9-nova", "max")).toEqual({ reasoning_effort: "max" });
    expect(sent("gpt-5.9-nova", "high")).toEqual({});
    expect(levels("gpt-5.8")).toHaveLength(6);
  });

  it("puts a model in a family and marks its thinking as always on", () => {
    setReasoningModelOverrides({
      families: [
        {
          id: "qwen",
          model: ["^tongyi-"],
          thinkingAlwaysOn: ["^tongyi-deep"],
          rules: [
            {
              match: "^tongyi-",
              levels: ["disabled", "automatic"],
            },
          ],
        },
      ],
    });

    expect(levels("tongyi-fast")).toEqual(["disabled", "automatic"]);
    expect(levels("tongyi-deep")).toEqual(["automatic"]);
    expect(sent("tongyi-fast", "disabled")).toEqual({ enable_thinking: false });
    expect(sent("tongyi-deep", "disabled")).toEqual({ enable_thinking: true });
  });

  it("rejects an invalid override and keeps the entries in place", () => {
    const valid = {
      families: [
        {
          id: "compatible",
          rules: [{ match: "kimi-k3", levels: ["low"] }],
        },
      ],
    };
    setReasoningModelOverrides(valid);

    for (const invalid of [
      { families: [{ id: "moonshot", rules: [] }] },
      {
        families: [
          { id: "compatible", rules: [{ match: "x", levels: ["ultra"] }] },
        ],
      },
      {
        families: [
          { id: "compatible", rules: [{ match: "(", levels: ["low"] }] },
        ],
      },
      // A rule without a pattern would take every model of the family.
      { families: [{ id: "openai", rules: [{ levels: ["low"] }] }] },
      { families: [{ id: "google", known: ["gemini-9"] }] },
    ]) {
      expect(() => setReasoningModelOverrides(invalid)).toThrow();
    }

    expect(levels("kimi-k3")).toEqual(["low"]);
    expect(levels("gpt-5.2")).toHaveLength(6);
  });
});
