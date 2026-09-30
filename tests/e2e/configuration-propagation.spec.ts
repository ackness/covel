import { expect, test } from "@playwright/test";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";

test("personal model configuration survives reload and reaches the request without display pricing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
    "llm.providers": [
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.invalid/v1",
        protocol: "openai-chat-v1",
        models: [
          { ref: "quick", modelId: "quick-model" },
          { ref: "detailed", modelId: "detailed-model" },
        ],
      },
    ],
    "llm.slotConfig": { story: { modelRef: "quick" } },
    "llm.capabilityOverrides": {
      story: { pricing: { inputPerMToken: 1, outputPerMToken: 2 } },
    },
  });
  await page.route("**/api/llm-config", (route) =>
    route.fulfill({ json: { configured: false, providers: [], slots: {} } }),
  );
  await page.route("**/api/presets", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  let serverKeyReads = 0;
  await page.route("**/api/provider-keys", (route) => {
    serverKeyReads += 1;
    return route.fulfill({
      json: { fixture: "synthetic-old-server-key" },
    });
  });
  let configReloads = 0;
  await page.route("**/api/llm-config/reload", (route) => {
    configReloads += 1;
    return route.fulfill({ json: { ok: true, slots: [] } });
  });
  await page.route("**/api/model-db/lookup**", (route) =>
    route.fulfill({
      json: {
        found: true,
        source: "model-database",
        pricingKind: "reference",
        candidates: [],
        reasoning: null,
        capability: {
          input: ["text"],
          output: ["text"],
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
        },
      },
    }),
  );
  // Every AI call is intercepted; this regression must never reach a provider.
  await page.route("**/api/ai/**", (route) => route.abort());
  let request:
    | {
        body: unknown;
        keys: unknown;
        keysHeaderPresent: boolean;
        slots: Record<string, unknown>;
      }
    | undefined;
  await page.route("**/api/ai/ping", async (route) => {
    const headers = route.request().headers();
    request = {
      body: route.request().postDataJSON(),
      keys: headers["x-provider-keys"]
        ? JSON.parse(
            Buffer.from(headers["x-provider-keys"], "base64").toString("utf8"),
          )
        : {},
      keysHeaderPresent: "x-provider-keys" in headers,
      slots: JSON.parse(
        Buffer.from(headers["x-slot-config"], "base64").toString("utf8"),
      ),
    };
    await route.fulfill({ json: { ok: true, latencyMs: 1 } });
  });
  await page.goto("/session");
  const dialog = page.getByRole("dialog");
  const openSettings = () =>
    page.getByRole("button", { name: /Configure Providers & Models/i }).click();
  const openProvider = async () => {
    await dialog
      .getByRole("button", { name: "Providers & Models", exact: true })
      .click();
    await dialog.getByRole("button", { name: /fixture.*2 models/ }).click();
  };
  await openSettings();
  await openProvider();
  await dialog
    .getByRole("textbox", { name: "API endpoint", exact: true })
    .fill("https://updated-fixture.invalid/v1");
  await dialog
    .getByRole("textbox", { name: "API endpoint", exact: true })
    .press("Enter");
  await dialog
    .getByLabel("Fixture", { exact: true })
    .fill("synthetic-player-key");
  await dialog
    .getByRole("spinbutton", { name: "fixture Price multiplier" })
    .fill("0.5");
  await dialog
    .getByRole("spinbutton", { name: "fixture Price multiplier" })
    .press("Enter");
  await dialog
    .getByRole("button", { name: "Model Roles", exact: true })
    .click();
  const story = dialog.getByRole("group", { name: "story", exact: true });
  await story
    .getByRole("combobox", { name: "Model configuration", exact: true })
    .selectOption("model:detailed");
  await story.getByRole("button", { name: /Generation parameters/ }).click();
  await story
    .getByRole("spinbutton", { name: "Temperature", exact: true })
    .fill("0.4");
  await story
    .getByRole("spinbutton", { name: "Temperature", exact: true })
    .press("Tab");
  await story
    .getByRole("spinbutton", { name: /^Max output tokens$/i })
    .fill("6000");
  await story
    .getByRole("spinbutton", { name: /^Max output tokens$/i })
    .press("Enter");
  await story
    .getByRole("spinbutton", { name: "Context Window (tokens)", exact: true })
    .fill("64000");
  await story
    .getByRole("spinbutton", { name: "Context Window (tokens)", exact: true })
    .press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const entries = JSON.parse(
          localStorage.getItem("covel:settings") ?? "{}",
        ).entries;
        return entries?.["llm.capabilityOverrides"]?.story?.contextWindow;
      }),
    )
    .toBe(64000);
  await page.keyboard.press("Escape");
  await page.reload();
  await openSettings();
  await dialog
    .getByRole("button", { name: "Model Roles", exact: true })
    .click();
  await expect(
    story.getByRole("combobox", { name: "Model configuration", exact: true }),
  ).toHaveValue("model:detailed");
  await story.getByRole("button", { name: /Generation parameters/ }).click();
  await expect(
    story.getByRole("spinbutton", { name: "Temperature", exact: true }),
  ).toHaveValue("0.4");
  await expect(
    story.getByRole("spinbutton", { name: /^Max output tokens$/i }),
  ).toHaveValue("6000");
  await expect(
    story.getByRole("spinbutton", {
      name: "Context Window (tokens)",
      exact: true,
    }),
  ).toHaveValue("64000");
  await openProvider();
  await expect(
    dialog.getByRole("textbox", { name: "API endpoint", exact: true }),
  ).toHaveValue("https://updated-fixture.invalid/v1");
  await expect(dialog.getByLabel("Fixture", { exact: true })).toHaveValue(
    "synthetic-player-key",
  );
  await dialog
    .getByRole("group", { name: "detailed-model", exact: true })
    .getByRole("button", { name: "Ping", exact: true })
    .click();
  await expect.poll(() => request).toBeDefined();
  expect(request!.body).toEqual({ modelRef: "detailed" });
  expect(request!.keys).toEqual({ fixture: "synthetic-player-key" });
  expect(request!.slots.slotBindings).toMatchObject({
    story: { modelRef: "detailed" },
  });
  expect(request!.slots.parameterOverrides).toMatchObject({
    story: { temperature: 0.4, maxOutputTokens: 6000 },
  });
  expect(request!.slots.capabilityOverrides).toMatchObject({
    story: { contextWindow: 64000 },
  });
  expect(request!.slots.customPresets).toEqual([
    {
      id: "detailed",
      name: "detailed-model",
      provider: "fixture",
      model: "detailed-model",
      baseUrl: "https://updated-fixture.invalid/v1",
      protocol: "openai-chat-v1",
    },
  ]);
  expect(JSON.stringify(request)).not.toContain("pricing");
  expect(JSON.stringify(request)).not.toContain("providerPriceMultipliers");

  await dialog.getByLabel("Fixture", { exact: true }).fill("");
  await dialog.getByLabel("Fixture", { exact: true }).press("Tab");
  await dialog
    .getByRole("button", { name: "Model Roles", exact: true })
    .click();
  const reloadConfig = dialog.getByRole("button", {
    name: "Reload config",
    exact: true,
  });
  await reloadConfig.click();
  await expect.poll(() => configReloads).toBe(1);
  await expect(reloadConfig).toBeEnabled();
  await openProvider();
  await expect(dialog.getByLabel("Fixture", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.reload();
  await openSettings();
  await openProvider();
  await expect(dialog.getByLabel("Fixture", { exact: true })).toHaveValue("");
  request = undefined;
  const clearedRequest = () => request;
  await dialog
    .getByRole("group", { name: "detailed-model", exact: true })
    .getByRole("button", { name: "Ping", exact: true })
    .click();
  await expect.poll(clearedRequest).toBeDefined();
  expect(clearedRequest()!.keys).toEqual({});
  expect(clearedRequest()!.keysHeaderPresent).toBe(false);
  expect(serverKeyReads).toBe(0);
});
