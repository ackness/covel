import { expect, test } from "@playwright/test";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

test("same-named local and server models remain distinct in role selection and ping requests", async ({
  page,
}) => {
  const id = "shared-model-id";
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
    "llm.providers": [
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.invalid",
        protocol: "openai-chat-v1",
        models: [
          { ref: id, name: "Local configuration", modelId: "local-api-model" },
        ],
      },
    ],
    "llm.slotConfig": { story: { modelRef: id }, plugin: { presetId: id } },
  });
  await page.route("**/api/presets", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id,
            name: "Server configuration",
            provider: "fixture",
            model: "server-api-model",
            enabled: true,
            isDefault: true,
            scope: "server",
            protocol: "openai-chat-v1",
            baseUrl: "https://fixture.invalid",
          },
        ],
      },
    }),
  );
  const serverSlot = {
    provider: "fixture",
    model: "server-api-model",
    protocol: "openai-chat-v1",
    tag: "text",
  };
  await page.route("**/api/llm-config", (route) =>
    route.fulfill({
      json: {
        configured: true,
        providers: ["fixture"],
        slots: { story: serverSlot, plugin: serverSlot },
      },
    }),
  );
  await page.route("**/api/model-db/lookup**", (route) =>
    route.fulfill({
      json: {
        found: true,
        source: "known",
        pricingKind: "unknown",
        candidates: [],
        reasoning: null,
        capability: {
          input: ["text"],
          output: ["text"],
          contextWindow: 128_000,
        },
      },
    }),
  );
  const probes: Array<{
    target: Record<string, unknown>;
    overlay: Record<string, unknown>;
  }> = [];
  await page.route("**/api/ai/ping", async (route) => {
    const request = route.request();
    const target = request.postDataJSON() as Record<string, unknown>;
    const encoded = request.headers()["x-slot-config"];
    probes.push({
      target,
      overlay: encoded
        ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
        : {},
    });
    await route.fulfill({
      json: {
        ok: true,
        latencyMs: target.modelRef ? 17 : 29,
        testedTarget: {
          provider: "fixture",
          model: target.modelRef ? "local-api-model" : "server-api-model",
          presetId: id,
          resolvedVia: "direct",
        },
      },
    });
  });
  await page.goto("/session");
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Model Roles", exact: true })
    .click();
  const story = dialog.getByRole("group", { name: "story", exact: true });
  const plugin = dialog.getByRole("group", { name: "plugin", exact: true });
  const storyModel = story.getByRole("combobox", {
    name: "Model configuration",
    exact: true,
  });
  const pluginModel = plugin.getByRole("combobox", {
    name: "Model configuration",
    exact: true,
  });
  await expect(storyModel).toHaveValue(`model:${id}`);
  await expect(pluginModel).toHaveValue(`preset:${id}`);
  await storyModel.selectOption({ label: "Server configuration" });
  await pluginModel.selectOption({ label: "Local configuration" });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("covel:settings")!).entries[
            "llm.slotConfig"
          ],
      ),
    )
    .toEqual({
      story: { presetId: id },
      plugin: { modelRef: id },
    });

  await dialog.getByRole("button", { name: "Generation", exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "Select Slot" })
    .selectOption("story");
  await expect(
    dialog.getByText("server-api-model", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Select Slot" })
    .selectOption("plugin");
  await expect(
    dialog.getByText("local-api-model", { exact: true }),
  ).toBeVisible();

  await dialog
    .getByRole("button", { name: "Providers & Models", exact: true })
    .click();
  await dialog.getByRole("button", { name: /fixture.*2 models/ }).click();
  const local = dialog.getByRole("group", {
    name: "Local configuration",
    exact: true,
  });
  const server = dialog.getByRole("group", {
    name: "Server configuration",
    exact: true,
  });
  await local.getByRole("button", { name: "Ping", exact: true }).click();
  await expect(local.getByText("17ms", { exact: true })).toBeVisible();
  await server.getByRole("button", { name: "Ping", exact: true }).click();
  await expect(server.getByText("29ms", { exact: true })).toBeVisible();
  expect(probes.map((probe) => probe.target)).toEqual([
    { modelRef: id },
    { presetId: id },
  ]);
  for (const { overlay } of probes) {
    expect(overlay.slotBindings).toEqual({
      story: { presetId: id },
      plugin: { modelRef: id },
    });
    expect(overlay.customPresets).toEqual([
      expect.objectContaining({ id, model: "local-api-model" }),
    ]);
  }
  await page.keyboard.press("Escape");
  await page.reload();
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  await dialog
    .getByRole("button", { name: "Model Roles", exact: true })
    .click();
  await expect(storyModel).toHaveValue(`preset:${id}`);
  await expect(pluginModel).toHaveValue(`model:${id}`);
});

test("role choices respect model capabilities and show each configuration's actual connection", async ({
  page,
}) => {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
    "llm.providers": [
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://local.example/v1",
        protocol: "openai-chat-v1",
        models: [
          { ref: "chat", modelId: "chat-model", name: "Local chat" },
          {
            ref: "judge",
            modelId: "typesafe/jev-1.13",
            name: "Local judge",
            protocol: "openrouter-decisions-v1",
          },
        ],
      },
    ],
    "llm.slotConfig": {
      story: { modelRef: "judge" },
      intent: { modelRef: "judge" },
    },
  });
  const textModel = {
    provider: "fixture",
    model: "base-chat",
    protocol: "openai-chat-v1",
    baseUrl: "https://server.example/v1",
    capability: { input: ["text"], output: ["text"] },
  };
  const evaluationModel = {
    ...textModel,
    model: "typesafe/jev-1.13",
    protocol: "openrouter-decisions-v1",
    capability: { input: ["text"], output: ["evaluation"] },
  };
  await page.route("**/api/presets", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            ...textModel,
            id: "slot-story",
            name: "Configured chat",
            enabled: true,
            isDefault: true,
            scope: "server",
          },
          {
            ...evaluationModel,
            id: "slot-intent",
            name: "Configured judge",
            enabled: true,
            isDefault: false,
            scope: "server",
          },
        ],
      },
    }),
  );
  await page.route("**/api/llm-config", (route) =>
    route.fulfill({
      json: {
        configured: true,
        providers: ["fixture"],
        slots: {
          story: { ...textModel, tag: "text" },
          intent: { ...evaluationModel, tag: "evaluation" },
        },
      },
    }),
  );
  await page.route("**/api/model-db/lookup**", (route) => {
    const evaluation = route
      .request()
      .url()
      .includes("openrouter-decisions-v1");
    return route.fulfill({
      json: {
        found: false,
        source: "protocol-default",
        pricingKind: "unknown",
        candidates: [],
        reasoning: null,
        capability: {
          input: ["text"],
          output: [evaluation ? "evaluation" : "text"],
        },
      },
    });
  });
  await page.goto("/session");
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Model Roles", exact: true })
    .click();
  const story = dialog.getByRole("group", { name: "story", exact: true });
  await expect(story.getByRole("alert")).toContainText(
    "does not support this role",
  );
  const storyPicker = story.getByRole("combobox", {
    name: "Model configuration",
    exact: true,
  });
  await expect(
    storyPicker.getByRole("option", { name: "Local judge", exact: true }),
  ).toHaveCount(0);
  await storyPicker.selectOption({ label: "Local chat" });
  await expect(story.getByRole("alert")).toHaveCount(0);
  await expect(story.getByText(/https:\/\/local.example\/v1/)).toBeVisible();
  const intent = dialog.getByRole("group", { name: "intent", exact: true });
  const intentPicker = intent.getByRole("combobox", {
    name: "Model configuration",
    exact: true,
  });
  await expect(
    intentPicker.getByRole("option", { name: "Local chat", exact: true }),
  ).toHaveCount(0);
  await expect(intentPicker).toHaveValue("model:judge");
  await expect(intent.getByText("evaluation", { exact: true })).toBeVisible();
  await expect(
    intent.getByRole("button", { name: /Generation parameters/ }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Generation", exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "Select Slot", exact: true })
    .selectOption("intent");
  await expect(dialog.getByRole("status")).toContainText(
    "This model does not generate text",
  );
  await expect(dialog.getByRole("slider")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Providers & Models", exact: true })
    .click();
  await dialog.getByRole("button", { name: /fixture.*4 models/ }).click();
  await expect(
    dialog.getByText("Connection edits apply to local models.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("group", { name: "Configured chat", exact: true })
      .getByText(/https:\/\/server.example\/v1/),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("group", { name: "Local judge", exact: true })
      .getByText(/https:\/\/local.example\/v1/),
  ).toBeVisible();
});
