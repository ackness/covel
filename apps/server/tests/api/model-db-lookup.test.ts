import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createOpenAiChatAdapter,
  createProviderRegistry,
} from "@covel/ai-provider";

import { createModelDbRoutes } from "../../src/routes/model-db.js";

describe("model database lookup", () => {
  it("returns provider-aware reasoning effort options for namespaced IDs", async () => {
    const app = new Hono();
    app.route(
      "/",
      createModelDbRoutes({
        modelDb: undefined,
      } as never),
    );

    const params = new URLSearchParams({
      model: "deepseek/deepseek-v4-flash",
      provider: "openai",
      protocol: "openai-chat-v1",
    });
    const response = await app.request(`/api/model-db/lookup?${params}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      matchedModelId: "deepseek-v4-flash",
      reasoning: {
        family: "deepseek",
        defaultValue: "high",
        options: [{ value: "disabled" }, { value: "high" }, { value: "max" }],
      },
    });
  });

  it("keeps model facts while exposing the selected built-in adapter envelope", async () => {
    const app = new Hono();
    app.route("/", createModelDbRoutes({ modelDb: undefined } as never));

    const base = new URLSearchParams({
      model: "gpt-4o",
      provider: "openai",
      protocol: "openai-responses-v1",
    });
    const rawResponse = await app.request(`/api/model-db/lookup?${base}`);
    const raw = await rawResponse.json();
    expect(raw.capability.input).toEqual(["text", "image", "audio", "file"]);
    expect(raw.capability.features).toContain("web_search");
    expect(raw.effectiveCapability).toBeUndefined();

    base.set("role", "text");
    const effectiveResponse = await app.request(`/api/model-db/lookup?${base}`);
    const effective = await effectiveResponse.json();
    expect(effective.capability).toEqual(raw.capability);
    expect(effective.effectiveCapability.input).toEqual(["text", "image"]);
    expect(effective.effectiveCapability.output).toEqual(["text"]);
    expect(effective.effectiveCapability.features).not.toContain("web_search");

    base.set("role", "transcription");
    const transcriptionResponse = await app.request(
      `/api/model-db/lookup?${base}`,
    );
    const transcription = await transcriptionResponse.json();
    expect(transcription.effectiveCapability.input).toEqual(
      raw.capability.input,
    );
  });

  it("does not project capabilities for a registered custom adapter", async () => {
    const app = new Hono();
    app.route(
      "/",
      createModelDbRoutes({
        modelDb: undefined,
        providerRegistry: createProviderRegistry({
          providers: {
            custom: { adapter: createOpenAiChatAdapter() },
          },
        }),
      } as never),
    );

    const params = new URLSearchParams({
      model: "gpt-4o",
      provider: "custom",
      protocol: "openai-chat-v1",
      role: "text",
    });
    const response = await app.request(`/api/model-db/lookup?${params}`);
    const body = await response.json();
    expect(body.usesBuiltinAdapter).toBe(false);
    expect(body.effectiveCapability).toBeUndefined();
    expect(body.capability.input).toEqual(["text", "image", "audio", "file"]);
  });
});
