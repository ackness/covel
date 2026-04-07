import { describe, it, expect } from "vitest";
import { bootstrapKernel } from "../src/index.js";
import { createPluginHost } from "@covel/plugin-runtime";
import type { KernelInput } from "@covel/shared";
import type { GatewayLike } from "@covel/runtime";

function createStubGateway(): GatewayLike {
  return {
    async generateText() {
      return {
        text: "stub",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async *streamText() {
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

describe("custom runtime handler event context", () => {
  it("passes the triggering event into ctx.context.event", async () => {
    const host = createPluginHost();

    host.pluginRegistry.add(
      {
        schemaVersion: "1.0",
        id: "event-plugin",
        displayName: "Event Plugin",
        version: "0.1.0",
        author: "test",
        description: "test plugin",
        defaultLocale: "en-US",
        supportedLocales: ["en-US"],
      },
      "/tmp/event-plugin",
    );

    host.runtimeRegistry.register("event-plugin", {
      id: "listener",
      pluginId: "event-plugin",
      kind: "plugin",
      phase: "post_story",
      trigger: { mode: "event", onEvents: ["image.generation.requested"] },
      tools: [],
      hooks: [],
    });

    host.runtimeRegistry.setHandler("event-plugin", "listener", async (ctx) => {
      const event = (ctx.context as { event?: { type?: string; payload?: Record<string, unknown> } }).event;
      return {
        proposals:
          event?.type === "image.generation.requested" &&
          event.payload?.scenePrompt === "A cave"
            ? [{ kind: "ui.render", payload: { type: "debug", content: { seen: true } } }]
            : [],
      };
    });

    const input: KernelInput = {
      runId: "run-1",
      branchId: "branch-1",
      actorId: "player-1",
      type: "image.generation.requested",
      locale: "en-US",
      payload: { scenePrompt: "A cave" },
    };

    const session = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() }).createSession();
    const result = await session.executeTurn(input);

    expect(result.render.blocks).toHaveLength(1);
    expect(result.render.blocks[0]).toMatchObject({
      type: "debug",
      content: { seen: true },
    });
  });
});
