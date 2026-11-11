import { describe, expect, it } from "vitest";
import { createProviderRegistry, parseLlmConfig } from "@covel/ai-provider";
import type { AiStack } from "../../src/ai-setup.js";
import { createModelDbRoutes } from "../../src/routes/model-db.js";

type Registry = ReturnType<typeof createProviderRegistry>;
function appFor(registry: Registry, apiKeys: Record<string, string> = {}) {
  return createModelDbRoutes(
    { providerRegistry: registry } as AiStack,
    apiKeys,
  );
}
async function ready(
  app: ReturnType<typeof appFor>,
  target: { provider: string; baseUrl?: string; protocol?: string },
) {
  const model = "gpt-4o";
  const params = new URLSearchParams({
    model,
    provider: target.provider,
    credentials: "1",
  });
  if (target.protocol) params.set("protocol", target.protocol);
  const response = await app.request(`/api/model-db/lookup?${params}`, {
    headers: {
      "X-Slot-Config": Buffer.from(
        JSON.stringify({ customPresets: [{ id: "lookup", model, ...target }] }),
      ).toString("base64"),
    },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).not.toHaveProperty("baseUrl");
  expect(body).not.toHaveProperty("apiKey");
  expect(body).not.toHaveProperty("headers");
  expect(JSON.stringify(body)).not.toContain("synthetic-");
  return body.serverCredentialsAvailable;
}

describe("request-scoped model credential readiness", () => {
  it("does not trust a matching server preset override as a provider default", async () => {
    const { aiConfig } = parseLlmConfig(
      '[covel.story]\nprovider="openai"\nbaseUrl="https://trusted.example/v1"\nmodel="a"\n[covel.plugin]\nprovider="openai"\nbaseUrl="https://override.example/v1"\nmodel="b"\n',
    );
    const registry = createProviderRegistry({
      providerDefaults: aiConfig.providers,
    });
    const env = { openai: "synthetic-env-key" };
    const preset = aiConfig.presets.find(
      (entry) => entry.defaultSlot === "plugin",
    )!;
    expect(
      registry.withApiKeys(registry.resolve(preset), {}, "openai", env).config
        .apiKey,
    ).toBe("synthetic-env-key");
    const app = appFor(registry, env);
    expect(
      await ready(app, {
        provider: "openai",
        baseUrl: preset.baseUrl,
        protocol: preset.protocol,
      }),
    ).toBe(false);
    expect(
      await ready(app, {
        provider: "openai",
        baseUrl: "https://TRUSTED.example:443/other",
      }),
    ).toBe(true);
  });

  it("resolves omitted and empty builtin endpoints canonically without borrowing another provider's key", async () => {
    const app = appFor(createProviderRegistry(), {
      openai: "synthetic-env-key",
    });
    expect(await ready(app, { provider: "openai" })).toBe(true);
    expect(await ready(app, { provider: "openai", baseUrl: "" })).toBe(true);
    expect(
      await ready(app, {
        provider: "openai",
        baseUrl: "https://foreign.example",
      }),
    ).toBe(false);
    expect(await ready(app, { provider: "anthropic" })).toBe(false);
    expect(await ready(app, { provider: "ollama" })).toBe(true);
  });

  it.each(["Authorization", "X-Api-Key", "X-Goog-Api-Key"])(
    "uses header-only protocol credentials (%s) only on their trusted route",
    async (name) => {
      const registry = createProviderRegistry({
        providers: {
          configured: {
            defaults: { baseUrl: "https://default.example/v1" },
            protocols: {
              "openai-chat-v1": {
                defaults: {
                  baseUrl: "https://route.example/v1",
                  headers: { [name]: "synthetic-header" },
                },
              },
            },
          },
        },
      });
      const app = appFor(registry);
      expect(
        await ready(app, {
          provider: "configured",
          protocol: "openai-chat-v1",
          baseUrl: "https://route.example/other",
        }),
      ).toBe(true);
      expect(
        await ready(app, {
          provider: "configured",
          protocol: "anthropic-messages-v1",
          baseUrl: "https://route.example/other",
        }),
      ).toBe(false);
      expect(
        await ready(app, {
          provider: "configured",
          protocol: "openai-chat-v1",
          baseUrl: "https://foreign.example",
        }),
      ).toBe(false);
    },
  );

  it("does not opt ordinary catalogue requests into credentials or accept missing/mismatched request configuration", async () => {
    const app = appFor(createProviderRegistry());
    const ordinary = await app.request(
      "/api/model-db/lookup?model=gpt-4o&provider=openai",
    );
    expect(await ordinary.json()).not.toHaveProperty(
      "serverCredentialsAvailable",
    );
    expect(
      (
        await app.request(
          "/api/model-db/lookup?model=gpt-4o&provider=openai&credentials=1",
        )
      ).status,
    ).toBe(400);
    const response = await app.request(
      "/api/model-db/lookup?model=gpt-4o&provider=openai&credentials=1",
      {
        headers: {
          "X-Slot-Config": Buffer.from(
            JSON.stringify({
              customPresets: [
                { id: "lookup", model: "gpt-4o", provider: "anthropic" },
              ],
            }),
          ).toString("base64"),
        },
      },
    );
    expect(response.status).toBe(400);
  });
});
