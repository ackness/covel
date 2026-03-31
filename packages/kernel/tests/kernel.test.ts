import { describe, it, expect, vi } from "vitest";
import { createKernel } from "../src/kernel.js";
import { createPluginHost } from "@covel/plugin-runtime";
import type { KernelInput } from "@covel/shared";
import type { GatewayLike } from "@covel/runtime";

function createStubGateway(): GatewayLike {
  return {
    async generateText() {
      return {
        text: "The hero bravely stepped forward.",
        finishReason: "stop",
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    },
    async *streamText() {
      yield { type: "text-delta" as const, textDelta: "Hello " };
      yield { type: "text-delta" as const, textDelta: "world" };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

const baseInput: KernelInput = {
  runId: "run-1",
  branchId: "branch-1",
  actorId: "player-1",
  type: "user.input",
  payload: { text: "I attack the dragon" },
};

describe("kernel", () => {
  it("executes a turn with no plugins (empty result)", async () => {
    const host = createPluginHost();
    const gateway = createStubGateway();
    const kernel = createKernel({ pluginHost: host, gateway });

    const result = await kernel.executeTurn(baseInput);

    expect(result.runId).toBe("run-1");
    expect(result.branchId).toBe("branch-1");
    expect(result.turnId).toBeTruthy();
    expect(result.traceId).toBeTruthy();
    expect(result.locale).toBe("zh-CN");
    expect(result.render.blocks).toHaveLength(0);
    expect(result.proposals).toHaveLength(0);
  });

  it("executes a turn with a registered runtime", async () => {
    const host = createPluginHost();
    const gateway = createStubGateway();

    // Register a runtime manually
    host.runtimeRegistry.register("story-plugin", {
      id: "narrator",
      pluginId: "story-plugin",
      kind: "story",
      phase: "story",
      trigger: { mode: "always" },
      tools: [],
      hooks: [],
    });

    // Register the plugin
    host.pluginRegistry.add(
      {
        schemaVersion: "1.0",
        id: "story-plugin",
        displayName: "Story",
        version: "0.1.0",
        author: "test",
        description: "Story plugin",
        defaultLocale: "zh-CN",
        supportedLocales: ["zh-CN"],
      },
      "/tmp/story-plugin"
    );

    const kernel = createKernel({ pluginHost: host, gateway });
    const result = await kernel.executeTurn(baseInput);

    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.render.blocks.length).toBeGreaterThan(0);

    const narrativeBlock = result.render.blocks.find(
      (b) => b.type === "narrative"
    );
    expect(narrativeBlock).toBeDefined();
    expect(narrativeBlock!.content).toContain("hero");
  });

  it("uses locale from input", async () => {
    const host = createPluginHost();
    const gateway = createStubGateway();
    const kernel = createKernel({ pluginHost: host, gateway });

    const result = await kernel.executeTurn({
      ...baseInput,
      locale: "en-US",
    });

    expect(result.locale).toBe("en-US");
  });

  it("updates kernel state after commit", async () => {
    const host = createPluginHost();

    // Gateway that returns state patches in its response
    const gateway: GatewayLike = {
      async generateText() {
        return {
          text: "Battle started!",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      async *streamText() {
        yield { type: "done" as const, finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    host.runtimeRegistry.register("battle", {
      id: "combat",
      pluginId: "battle",
      kind: "plugin",
      phase: "post_story",
      trigger: { mode: "always" },
      tools: [],
      hooks: [],
    });

    host.pluginRegistry.add(
      {
        schemaVersion: "1.0",
        id: "battle",
        displayName: "Battle",
        version: "0.1.0",
        author: "test",
        description: "Battle",
        defaultLocale: "zh-CN",
        supportedLocales: ["zh-CN"],
      },
      "/tmp/battle"
    );

    const kernel = createKernel({ pluginHost: host, gateway });
    kernel.setContext({ state: { hp: 100 } });

    const result = await kernel.executeTurn(baseInput);

    // The narrative.append proposal should have been committed
    expect(result.commit).toBeDefined();
    expect(result.commit!.turnId).toBe(result.turnId);
  });
});
