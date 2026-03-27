import { afterEach, describe, expect, it, vi } from "vitest";

const MODEL_GATEWAY_MODULE_ID = "../../../modules/model-gateway/src/index.js";
const COMPOSITION_MODULE_ID = "../src/composition.js";

describe("runtime composition session task binding routing", () => {
  afterEach(() => {
    vi.doUnmock(MODEL_GATEWAY_MODULE_ID);
    vi.resetModules();
  });

  it("uses session.taskBindings.story.narration when dispatching model calls", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      object: {
        content: "session preset response",
        blocks: []
      },
      finishReason: "stop",
      usage: {
        inputTokens: 1,
        outputTokens: 1
      }
    });
    const actualModelGateway = await vi.importActual<typeof import("../../../modules/model-gateway/src/index.js")>(
      MODEL_GATEWAY_MODULE_ID
    );

    vi.doMock(MODEL_GATEWAY_MODULE_ID, () => ({
      ...actualModelGateway,
      createModelProfileRegistry() {
        return {
          list() {
            return [];
          },
          resolveTextTarget(input: { presetId?: string }) {
            const presetId = input.presetId ?? "default-story";
            return {
              profile: {
                id: "medium",
                tier: "medium",
                provider: "openaiCompatible",
                model: presetId === "story-override" ? "override-model" : "default-model",
                contextWindow: 64_000,
                latencyClass: "medium",
                costClass: "medium",
                supportedModes: ["text", "object", "stream"]
              },
              preset: {
                id: presetId,
                name: presetId,
                provider: "openaiCompatible",
                model: presetId === "story-override" ? "override-model" : "default-model",
                tier: "medium",
                baseUrl: "https://example.test/v1",
                supportedModes: ["text", "object", "stream"],
                enabled: true,
                isDefault: presetId === "default-story",
                scope: "global"
              }
            };
          },
          resolveEmbeddingTarget() {
            return {
              profile: {
                id: "embed-default",
                tier: "embed-default",
                provider: "openaiCompatible",
                model: "embed-model",
                contextWindow: 8_000,
                latencyClass: "low",
                costClass: "low",
                supportedModes: ["embed"]
              },
              preset: null
            };
          }
        };
      },
      createModelGateway() {
        return {
          generateText: vi.fn(),
          generateObject,
          streamText: vi.fn(),
          embed: vi.fn()
        };
      }
    }));

    const { createRuntimeComposition } = await import(COMPOSITION_MODULE_ID);
    const runtime = await createRuntimeComposition({
      env: {}
    });
    await runtime.repositories.worlds.save({
      id: "world_01",
      name: "Northreach",
      description: "Frozen frontier",
      createdAt: new Date("2026-03-24T12:00:00.000Z")
    });
    await runtime.repositories.sessions.save({
      id: "session_01",
      worldId: "world_01",
      status: "active",
      taskBindings: {
        "story.narration": "story-override"
      },
      createdAt: new Date("2026-03-24T12:00:01.000Z")
    });

    await runtime.flowEngine.handle({
      requestId: "req_01",
      type: "send_message",
      sessionId: "session_01",
      locale: "zh-CN",
      payload: {
        content: "继续前进"
      }
    });

    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: "story-override"
      })
    );
  });
});
