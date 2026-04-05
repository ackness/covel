import { describe, expect, it } from "vitest";
import { bootstrapKernel } from "../src/kernel.js";
import { createPluginHost } from "@covel/plugin-runtime";
import type { GatewayLike } from "@covel/runtime";
import type { SlotRegistry } from "@covel/ai-provider";

function makeGateway(): GatewayLike & {
  capturedPresetIds: Array<string | undefined>;
  capturedProviderRequestMetadata: Array<Record<string, unknown> | undefined>;
} {
  const capturedPresetIds: Array<string | undefined> = [];
  const capturedProviderRequestMetadata: Array<Record<string, unknown> | undefined> = [];

  return {
    capturedPresetIds,
    capturedProviderRequestMetadata,
    async generateText(input) {
      capturedPresetIds.push(input.presetId);
      capturedProviderRequestMetadata.push(input.providerRequestMetadata);
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async *streamText(input) {
      capturedPresetIds.push(input.presetId);
      capturedProviderRequestMetadata.push(input.providerRequestMetadata);
      yield { type: "text-delta" as const, textDelta: "ok" };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

function makeSlotRegistry(): SlotRegistry {
  const slots = {
    story: { slotId: "story", presetId: "preset-story", tag: "text", parameterOverrides: { temperature: 0.4 } },
    utility: { slotId: "utility", presetId: "preset-utility", tag: "text" },
    image: { slotId: "image", presetId: "preset-image", tag: "image" },
  };

  return {
    configure: () => {},
    resolveSlot: (slotId) => slots[slotId as keyof typeof slots]?.presetId,
    listSlotsByTag: (tag) =>
      Object.values(slots).filter((slot) => slot.tag === tag),
    getSlotTag: (slotId) => slots[slotId as keyof typeof slots]?.tag,
    getParameterOverrides: (slotId) => slots[slotId as keyof typeof slots]?.parameterOverrides,
    listSlots: () => ({ ...slots }),
  };
}

function makePluginHost() {
  const host = createPluginHost();
  host.pluginRegistry.add(
    {
      schemaVersion: "1.0",
      id: "test-plugin",
      displayName: "Test",
      version: "0.1.0",
      author: "test",
      description: "",
      defaultLocale: "zh-CN",
      supportedLocales: ["zh-CN"],
    },
    "/virtual/test-plugin",
  );
  host.runtimeRegistry.register("test-plugin", {
    id: "story-runtime",
    pluginId: "test-plugin",
    kind: "story",
    phase: "story",
    priority: 400,
    trigger: { mode: "always" },
    providerTag: "text",
    tools: [],
    hooks: [],
  });
  return host;
}

describe("kernel runtime slot resolution", () => {
  it("uses the first compatible slot when a runtime has no explicit binding", async () => {
    const gateway = makeGateway();
    const instance = bootstrapKernel({
      pluginHost: makePluginHost(),
      gateway,
      slotRegistry: makeSlotRegistry(),
    });

    await instance.createSession().executeTurn({
      type: "user.input",
      content: "hello",
      runId: "run-1",
      branchId: "branch-1",
    });

    expect(gateway.capturedPresetIds).toContain("preset-story");
  });

  it("applies slot preset overrides and parameter overrides to the resolved slot", async () => {
    const gateway = makeGateway();
    const instance = bootstrapKernel({
      pluginHost: makePluginHost(),
      gateway,
      slotRegistry: makeSlotRegistry(),
    });

    await instance.createSession().executeTurn(
      {
        type: "user.input",
        content: "hello",
        runId: "run-1",
        branchId: "branch-1",
      },
      {
        slotPresetOverrides: { story: "custom-story-preset" },
        slotParameterOverrides: { story: { temperature: 0.9, maxOutputTokens: 777 } },
      },
    );

    expect(gateway.capturedPresetIds).toContain("custom-story-preset");
    expect(gateway.capturedProviderRequestMetadata).toContainEqual({
      parameterOverrides: { temperature: 0.9, maxOutputTokens: 777 },
    });
  });
});
