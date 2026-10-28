import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ProviderRelay } from "@covel/ai-provider";
import { createGatewayAdapter } from "../src/llm/gateway-llm-adapter.js";
import { createPluginRuntimeGateway } from "../src/function-runtime/plugin-runtime-gateway.js";
import { modelGateway } from "./helpers/model-gateway.js";

describe("runtime gateway model relay", () => {
  it.each(["generate", "stream", "function-text", "function-object"] as const)(
    "preserves the requesting browser's transport for %s calls",
    async (mode) => {
      const fetch = vi.fn(async () => new Response("ok"));
      const relay: ProviderRelay = { fetch };
      const gateway = modelGateway(async (provider) => {
        // Exercise the real gateway's option-to-provider composition, not
        // just the options handed to a mocked gateway method.
        expect(provider.relay).toBe(relay);
        await provider.relay!.fetch({
          url: "http://127.0.0.1:3425/v1/responses",
          method: "POST",
          headers: {},
          body: "{}",
        });
      });
      const options = { apiKeys: { fixture: "test-key" }, relay };
      if (mode === "generate" || mode === "stream") {
        const adapter = createGatewayAdapter(gateway, options);
        const request = {
          model: "fixture",
          messages: [{ role: "user" as const, content: "Begin the story" }],
        };
        if (mode === "generate") {
          expect((await adapter.generate(request)).content).toBe("ok");
        } else {
          expect(
            await Array.fromAsync(adapter.stream!(request)),
          ).toContainEqual(
            expect.objectContaining({ type: "text-delta", textDelta: "ok" }),
          );
        }
      } else {
        const adapter = createPluginRuntimeGateway(gateway, {
          ...options,
          toZodSchema: () => z.object({ ok: z.boolean() }),
        });
        if (mode === "function-text") {
          expect(
            (await adapter.generateText({ prompt: "Continue" })).text,
          ).toBe("ok");
        } else {
          expect(
            (
              await adapter.generateObject({
                prompt: "Update state",
                schema: {},
              })
            ).object,
          ).toEqual({ ok: true });
        }
      }
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});
