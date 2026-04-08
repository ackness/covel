import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createPluginManager } from "../../../packages/plugin-manager/src/index.ts";
import { createServiceGateway, createToolGatewayService } from "@covel/services";
import { createV1RuntimeExecutor } from "../src/v1-runtime-executor.js";

const PLUGIN_DEMO_DIR = resolve(import.meta.dirname, "../../../docs/plugin-system-v1/plugin-demo");
const IMAGE_DEMO_DIR = resolve(import.meta.dirname, "../../../docs/plugin-system-v1/image-workflow-demo");

describe("createV1RuntimeExecutor", () => {
  it("executes a text runtime and parses structured output", async () => {
    const manager = createPluginManager();
    await manager.load(PLUGIN_DEMO_DIR);
    const runtime = manager.registries.runtimes.get("demo-plugin", "luck-roller");
    if (!runtime) throw new Error("runtime not found");

    const services = createServiceGateway();
    services.tools = createToolGatewayService({
      registry: manager.registries.tools,
      approvals: services.approvals,
      trace: services.traceStore,
    });

    const executeRuntime = createV1RuntimeExecutor({
      services,
      resolveGatewayForRuntime: async () => ({
        presetId: "plugin",
        slotTag: "text",
        gateway: {
          async generateText() {
            return {
              text: JSON.stringify({
                applied: false,
                reason: "no-trigger",
                tier: "none",
                roll: null,
                modifier: null,
                eventId: null,
                eventTitle: null,
                eventEffect: null,
                eventTag: null,
                tableKey: null,
              }),
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
          async generateImage() {
            throw new Error("not used");
          },
        } as any,
      }),
    });

    const result = await executeRuntime(
      runtime,
      { type: "manual", sessionId: "s1", turnId: "t1", payload: { messageId: "m1" } },
      { sessionId: "s1", turnNumber: 1, isPreGame: false, preGameCompleted: new Set(), runCounts: new Map(), eventQueue: [], records: [] },
    );

    expect(result.status).toBe("success");
    expect((result.payload as any).reason).toBe("no-trigger");
  });

  it("executes an image runtime with previousStep input", async () => {
    const manager = createPluginManager();
    await manager.load(IMAGE_DEMO_DIR);
    const runtime = manager.registries.runtimes.get("image-workflow-demo", "image-generator");
    if (!runtime) throw new Error("runtime not found");

    const services = createServiceGateway();
    services.tools = createToolGatewayService({
      registry: manager.registries.tools,
      approvals: services.approvals,
      trace: services.traceStore,
    });

    const executeRuntime = createV1RuntimeExecutor({
      services,
      resolveGatewayForRuntime: async () => ({
        presetId: "plugin",
        slotTag: "image",
        imageApi: "openai-chat",
        gateway: {
          async generateText() {
            throw new Error("not used");
          },
          async generateImage() {
            return {
              images: [{ url: "https://example.com/generated.png", mimeType: "image/png" }],
              usage: null,
            };
          },
        } as any,
      }),
    });

    const result = await executeRuntime(
      runtime,
      {
        type: "manual",
        sessionId: "s1",
        turnId: "t2",
        payload: {
          previousStep: {
            runtimeId: "prompt-optimizer",
            status: "success",
            payload: {
              messageId: "m2",
              enhancedPrompt: "a cinematic forest scene",
              caption: "森林中的主角",
            },
          },
        },
      },
      { sessionId: "s1", turnNumber: 1, isPreGame: false, preGameCompleted: new Set(), runCounts: new Map(), eventQueue: [], records: [] },
    );

    expect(result.status).toBe("success");
    expect((result.payload as any).imageUrl).toBe("https://example.com/generated.png");
  });
});
