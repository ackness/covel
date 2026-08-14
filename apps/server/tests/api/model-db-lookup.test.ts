import { describe, expect, it } from "vitest";
import { Hono } from "hono";

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
});
