import { describe, expect, it, vi } from "vitest";
import { recommend, inputSchema } from "../server.js";
import handler from "../handler.js";

const options = [
  { id: "prompt:1", text: "Ask about the library" },
  { id: "prompt:2", text: "Explore the classroom" },
];
const input = {
  presetId: "intent",
  goal: "Follow the player",
  state: { scene: "School" },
  options,
};
function context(probabilities?: Record<string, number>) {
  return {
    signal: new AbortController().signal,
    gateway: {
      resolveSlot: vi.fn(() => ({ tag: "evaluation" })),
      evaluate: vi.fn(async () => ({
        model: "fixture/jev",
        provider: "fixture",
        answers: {
          recommendation: {
            type: "choice",
            choice: "prompt:2",
            ...(probabilities ? { probabilities } : {}),
          },
        },
      })),
    },
  };
}

describe("evaluation choice demo", () => {
  it("preserves model probabilities, role selection and the supplied candidate set", async () => {
    const ctx = context({ "prompt:1": 0.2, "prompt:2": 0.8 });
    expect(await recommend(input, ctx)).toMatchObject({
      status: "ready",
      selectedId: "prompt:2",
      options: [
        { ...options[0], probability: 0.2 },
        { ...options[1], probability: 0.8 },
      ],
    });
    expect(ctx.gateway.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: "intent",
        questions: {
          recommendation: {
            type: "choice",
            instructions: input.goal,
            criteria: Object.fromEntries(
              options.map(({ id, text }) => [id, text]),
            ),
          },
        },
      }),
    );
  });
  it("does not invent a distribution when a provider returns only a winner", async () => {
    expect(await recommend(input, context())).toMatchObject({
      status: "ready",
      options,
    });
  });
  it("degrades configuration/provider errors without fabricating probabilities, but preserves cancellation", async () => {
    const ctx = context({ "prompt:2": 0.8 });
    expect(await recommend(input, ctx)).toEqual({
      status: "unavailable",
      reason: "failed",
    });
    ctx.gateway.resolveSlot.mockReturnValue(null);
    expect(await recommend(input, ctx)).toEqual({
      status: "unavailable",
      reason: "unconfigured",
    });
    expect(await recommend(input, { signal: ctx.signal })).toEqual({
      status: "unavailable",
      reason: "unsupported",
    });
    const aborted = context();
    aborted.signal = AbortSignal.abort(new Error("player cancelled"));
    await expect(recommend(input, aborted)).rejects.toThrow("player cancelled");
  });
  it("rejects duplicate candidate IDs and publishes only its own data through the public service", async () => {
    expect(() =>
      inputSchema.parse({ ...input, options: [options[0], options[0]] }),
    ).toThrow();
    const call = vi.fn(async () => ({
      status: "ready",
      model: "fixture/jev",
      selectedId: "prompt:2",
      options,
    }));
    const result = await handler({
      pluginId: "jev-choice-demo",
      turnId: "turn-2",
      playerMessage: "Explore",
      services: { call },
      userSettings: { evaluationSlot: "intent" },
      inputs: {
        choices: {
          cardinality: "one",
          source: {
            pluginId: "choices",
            runtimeId: "choices/generate",
            resultId: "result-2",
          },
          value: {
            scene: "School",
            recap: "You arrived",
            decision: "Where next?",
            prompts: options,
          },
        },
        narrative: { cardinality: "one", value: "A class is about to start." },
      },
    });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "demo/choice-recommendation@1",
        input: expect.objectContaining({ presetId: "intent" }),
      }),
    );
    expect(result.effects.pluginData).toEqual([
      {
        namespace: "recommendations",
        key: "current",
        value: expect.objectContaining({
          turnId: "turn-2",
          selectedId: "prompt:2",
        }),
      },
    ]);
    expect(result.effects).not.toHaveProperty("events");
    expect(await handler({ inputs: {} })).toMatchObject({ outcome: "skipped" });
  });
});
