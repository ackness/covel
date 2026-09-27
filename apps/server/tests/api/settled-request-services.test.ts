import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AiStack } from "../../src/ai-setup.js";
import type { PluginRuntimeGateway } from "@covel/plugin-loader";
import { createPerRequestLlmMiddleware } from "../../src/middleware/per-request-llm.js";
import { requestJobServices } from "../../src/routes/api/plugin-rpc/settled-request.js";

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64");

describe("detached request service admission", () => {
  it.each([
    { label: "no headers", headers: {}, handoff: false, ready: false },
    {
      label: "empty headers",
      headers: { "X-Provider-Keys": b64({}), "X-Slot-Config": b64({}) },
      handoff: false,
      ready: false,
    },
    {
      label: "unrelated headers",
      headers: { "X-Unrelated": "value" },
      handoff: false,
      ready: false,
    },
    {
      label: "unrelated provider credentials",
      headers: { "X-Provider-Keys": b64({ other: "synthetic-other" }) },
      handoff: true,
      ready: false,
    },
    {
      label: "parameter-only overrides",
      headers: {
        "X-Slot-Config": b64({
          parameterOverrides: { background: { temperature: 0.5 } },
        }),
      },
      handoff: true,
      ready: false,
    },
    {
      label: "matching provider credentials",
      headers: { "X-Provider-Keys": b64({ target: "synthetic-target" }) },
      handoff: true,
      ready: true,
    },
  ])(
    "does not bypass server readiness with $label",
    async ({ headers, handoff, ready }) => {
      const resolveSlot = vi.fn(
        (
          _model: string | undefined,
          options?: { apiKeys?: Record<string, string> },
        ) => ({
          presetId: "background",
          provider: "target",
          model: "model",
          protocol: "openai-chat-v1",
          tag: "text",
          metadata: {},
          apiKey: options?.apiKeys?.target,
        }),
      );
      const ai = { gateway: { resolveSlot } } as unknown as AiStack;
      const defaultAdapter = { generate: vi.fn() };
      const defaultGateway = {
        resolveSlot: vi.fn(() => null),
      } as unknown as PluginRuntimeGateway;
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("llmAdapter", defaultAdapter);
        c.set("pluginGateway", defaultGateway);
        await next();
      });
      app.use(
        "*",
        createPerRequestLlmMiddleware({
          ai,
          envApiKeys: {},
          defaultLlmAdapter: defaultAdapter,
          defaultPluginGateway: defaultGateway,
        }),
      );
      app.post("/admit", (c) => {
        const services = requestJobServices(c);
        return c.json({
          handoff: services !== undefined,
          ready: services?.canRun?.("background") ?? false,
          usesDefault: services?.llm === defaultAdapter,
        });
      });
      const response = await app.request("/admit", { method: "POST", headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        handoff,
        ready,
        usesDefault: false,
      });
      expect(defaultGateway.resolveSlot).not.toHaveBeenCalled();
      if (handoff)
        expect(resolveSlot).toHaveBeenCalledWith(
          "background",
          expect.any(Object),
        );
    },
  );
});
