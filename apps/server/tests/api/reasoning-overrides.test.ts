import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
} from "@covel/ai-provider";
import { createGatewayAdapter } from "@covel/runtime";
import type { PluginRuntimeGateway } from "@covel/plugin-loader";
import type { AiStack } from "../../src/ai-setup.js";
import { createPerRequestLlmMiddleware } from "../../src/middleware/per-request-llm.js";
import { outboundFetch } from "../../../../packages/ai-provider/src/outbound-network.js";

vi.mock("../../../../packages/ai-provider/src/outbound-network.js", () => ({
  outboundFetch: vi.fn(),
}));
const fetch = vi.mocked(outboundFetch);
afterEach(() => vi.resetAllMocks());

function fixture() {
  const bodies: Record<string, unknown>[] = [];
  fetch.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.stream) {
      return new Response(
        'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: {},
      }),
    );
  });
  const gateway = createGateway({
    presetRegistry: createPresetRegistry({ profiles: [], presets: [] }),
    providerRegistry: createProviderRegistry(),
  });
  const app = new Hono();
  app.use(
    "*",
    createPerRequestLlmMiddleware({
      ai: { gateway } as unknown as AiStack,
      envApiKeys: {},
      defaultLlmAdapter: createGatewayAdapter(gateway),
      defaultPluginGateway: {} as PluginRuntimeGateway,
    }),
  );
  app.post("/call", async (c) =>
    c.json(
      await c.get("llmAdapter").generate({
        model: "memory",
        defaults: { reasoningEffort: "disabled" },
        messages: [{ role: "user", content: "Extract facts." }],
      }),
    ),
  );
  app.post("/path/:kind/:slot", async (c) => {
    const model = c.req.param("slot");
    const messages = [
      { role: "user" as const, content: "Continue the story." },
    ];
    if (c.req.param("kind") === "function") {
      return c.json(
        await c
          .get("pluginGateway")
          .generateText({ presetId: model, messages }),
      );
    }
    if (c.req.param("kind") === "stream") {
      const events = [];
      for await (const event of c.get("llmAdapter").stream!({
        model,
        messages,
      }))
        events.push(event);
      return c.json(events);
    }
    return c.json(await c.get("llmAdapter").generate({ model, messages }));
  });
  const call = (modelDefault?: string, roleOverride?: string) =>
    app.request("/call", {
      method: "POST",
      headers: {
        "X-Slot-Config": Buffer.from(
          JSON.stringify({
            customPresets: [
              {
                id: "same-ref",
                name: "Synthetic",
                provider: "fixture",
                model: "qwen3.8-flash",
                baseUrl: "https://provider.example/v1",
                protocol: "openai-chat-v1",
                reasoningEffort: modelDefault,
              },
            ],
            slotPresetOverrides: { memory: "same-ref" },
            ...(roleOverride
              ? {
                  parameterOverrides: {
                    memory: { reasoningEffort: roleOverride },
                  },
                }
              : {}),
          }),
        ).toString("base64"),
      },
    });
  return { call, bodies, app };
}

describe("reasoning settings through the request boundary", () => {
  it.each(["generate", "stream", "function"])(
    "uses independent same-ID variants for all roles through %s",
    async (kind) => {
      const { app, bodies } = fixture();
      const headers = {
        "X-Slot-Config": Buffer.from(
          JSON.stringify({
            customPresets: [
              {
                id: "thinking-on",
                name: "Narration",
                reasoningEffort: "automatic",
              },
              {
                id: "thinking-off",
                name: "Quick tools",
                reasoningEffort: "disabled",
              },
            ].map((variant) => ({
              ...variant,
              provider: "fixture",
              model: "qwen3.8-flash",
              baseUrl: "https://provider.example/v1",
              protocol: "openai-chat-v1",
            })),
            slotPresetOverrides: {
              story: "thinking-on",
              plugin: "thinking-off",
              memory: "thinking-on",
              "custom-role": "thinking-off",
            },
          }),
        ).toString("base64"),
      };
      for (const [slot, expected] of [
        ["story", true],
        ["plugin", false],
        ["memory", true],
        ["custom-role", false],
      ] as const) {
        const response = await app.request(`/path/${kind}/${slot}`, {
          method: "POST",
          headers,
        });
        expect(response.status).toBe(200);
        if (kind === "stream") expect(await response.text()).toContain("hello");
        expect(bodies.at(-1)).toMatchObject({
          model: "qwen3.8-flash",
          enable_thinking: expected,
        });
        expect(bodies.at(-1)).not.toHaveProperty("reasoningEffort");
      }
      expect(bodies).toHaveLength(4);
    },
  );
  it.each([
    [undefined, undefined, false],
    ["automatic", undefined, true],
    ["automatic", "disabled", false],
    ["disabled", "automatic", true],
    ["automatic", "provider-default", undefined],
    ["provider-default", undefined, undefined],
    ["untrusted-value", undefined, false],
  ])("resolves model=%s role=%s to wire=%s", async (model, role, expected) => {
    const { call, bodies } = fixture();
    expect((await call(model, role)).status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.enable_thinking).toBe(expected);
    expect(bodies[0]).not.toHaveProperty("reasoningEffort");
    expect(bodies[0]).not.toHaveProperty("parameterOverrides");
  });

  it("isolates concurrent defaults for the same model reference", async () => {
    const { call, bodies } = fixture();
    const results = await Promise.all([call("automatic"), call("disabled")]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(bodies.map((body) => body.enable_thinking).sort()).toEqual([
      false,
      true,
    ]);
  });
});
