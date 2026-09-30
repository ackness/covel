import { describe, expect, it } from "vitest";
import type * as api from "@/services/api.js";
import { modelPriceKey, resolveLocalModelPrices } from "../-model-prices.js";
import { estimateModelCost } from "../-cost-panel.js";

const story: api.LlmSlotInfo = {
  provider: "server",
  model: "server-model",
  protocol: "openai-chat-v1",
  tag: "text",
};

const defaults = {
  bindings: {},
  customPresets: [],
  presets: [],
  slots: { story },
};

describe("local debug pricing", () => {
  it("prices the selected local model, retains partial database prices, and applies its multiplier", () => {
    const prices = resolveLocalModelPrices({
      ...defaults,
      overrides: { story: { pricing: { inputPerMToken: 0 } } },
      bindings: { story: { modelRef: "local" } },
      customPresets: [{ id: "local", provider: "player", model: "chosen" }],
    });
    expect(prices).toEqual({
      [modelPriceKey("player", "chosen")]: { inputPerMToken: 0 },
    });
    const price = {
      inputPerMToken: 2,
      outputPerMToken: 4,
      ...prices[modelPriceKey("player", "chosen")],
    };
    expect(
      estimateModelCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        price,
        0.5,
      ),
    ).toEqual({ usd: 1, pricedTokens: 1_500_000, unpricedTokens: 0 });
    expect(prices[modelPriceKey("server", "server-model")]).toBeUndefined();
    expect(prices[modelPriceKey("fallback", "chosen")]).toBeUndefined();
  });

  it("keeps local and server namespaces distinct even when IDs collide", () => {
    const args = {
      ...defaults,
      overrides: { story: { pricing: { inputPerMToken: 1 } } },
      customPresets: [{ id: "same", provider: "player", model: "chosen" }],
      presets: [
        {
          id: "same",
          provider: "server",
          model: "server-model",
          enabled: true,
        },
      ],
    };
    expect(
      resolveLocalModelPrices({
        ...args,
        bindings: { story: { modelRef: "same" } },
      }),
    ).toEqual({ [modelPriceKey("player", "chosen")]: { inputPerMToken: 1 } });
    expect(
      resolveLocalModelPrices({
        ...args,
        bindings: { story: { presetId: "same" } },
      }),
    ).toEqual({
      [modelPriceKey("server", "server-model")]: { inputPerMToken: 1 },
    });
    expect(
      resolveLocalModelPrices({
        ...args,
        bindings: { story: { modelRef: "removed" } },
      }),
    ).toEqual({});
  });

  it("uses an exact server slot target for unbound roles", () => {
    expect(
      resolveLocalModelPrices({
        ...defaults,
        overrides: {
          story: { pricing: { inputPerMToken: 1, outputPerMToken: 2 } },
          fast: { pricing: { inputPerMToken: 7 } },
        },
      }),
    ).toEqual({
      [modelPriceKey("server", "server-model")]: {
        inputPerMToken: 1,
        outputPerMToken: 2,
      },
    });
  });

  it("does not choose between conflicting slot prices for an aggregated model", () => {
    const args = { ...defaults, slots: { story, plugin: story } };
    expect(
      resolveLocalModelPrices({
        ...args,
        overrides: {
          story: { pricing: { inputPerMToken: 1 } },
          plugin: { pricing: { inputPerMToken: 2 } },
        },
      }),
    ).toEqual({ [modelPriceKey("server", "server-model")]: null });
    expect(
      resolveLocalModelPrices({
        ...args,
        overrides: {
          story: { pricing: { inputPerMToken: 1 } },
          plugin: { pricing: { inputPerMToken: 1 } },
        },
      }),
    ).toEqual({
      [modelPriceKey("server", "server-model")]: { inputPerMToken: 1 },
    });
  });
});
