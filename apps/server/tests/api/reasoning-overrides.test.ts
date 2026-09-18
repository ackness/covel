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
    bodies.push(JSON.parse(String(init?.body)));
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
  return { call, bodies };
}

describe("reasoning settings through the request boundary", () => {
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
