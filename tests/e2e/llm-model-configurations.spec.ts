import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

test("same API model configurations can be copied, named, shared, and imported independently", async ({
  page,
}) => {
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
          {
            ref: "quick",
            name: "Quick tools",
            modelId: "qwen3.8-flash",
            reasoningEffort: "disabled",
          },
        ],
      },
    ],
    "llm.slotConfig": {
      story: { modelRef: "quick" },
      plugin: { modelRef: "quick" },
    },
  });
  await page.route("**/api/llm-config", (route) =>
    route.fulfill({ json: { configured: false, providers: [], slots: {} } }),
  );
  await page.route("**/api/model-db/lookup**", (route) =>
    route.fulfill({
      json: {
        found: true,
        source: "known",
        pricingKind: "unknown",
        candidates: [],
        reasoning: {
          family: "qwen",
          options: [{ value: "disabled" }, { value: "automatic" }],
        },
        capability: {
          input: ["text"],
          output: ["text"],
          contextWindow: 128_000,
        },
      },
    }),
  );
  await page.goto("/session");
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Providers & Models", exact: true })
    .click();
  await dialog.getByRole("button", { name: /fixture.*1 models/ }).click();
  await dialog
    .getByRole("button", { name: "Duplicate configuration", exact: true })
    .click();
  const copy = dialog.getByRole("group", {
    name: "Quick tools copy",
    exact: true,
  });
  await copy.locator("summary").click();
  await copy
    .getByRole("textbox", { name: "Configuration name" })
    .fill("Detailed story");
  await copy.getByRole("textbox", { name: "Configuration name" }).press("Tab");
  const renamed = dialog.getByRole("group", {
    name: "Detailed story",
    exact: true,
  });
  await renamed
    .getByRole("combobox", { name: "Reasoning effort" })
    .selectOption("automatic");
  await expect(
    renamed.getByRole("option", { name: "Thinking on", exact: true }),
  ).toHaveCount(1);

  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const downloaded = await downloadPromise;
  const exported = await readFile((await downloaded.path())!);
  const profiles = JSON.parse(exported.toString("utf8")).providers;
  expect(profiles[0].models).toEqual([
    {
      ref: "quick",
      name: "Quick tools",
      modelId: "qwen3.8-flash",
      reasoningEffort: "disabled",
    },
    {
      ref: expect.any(String),
      name: "Detailed story",
      modelId: "qwen3.8-flash",
      reasoningEffort: "automatic",
    },
  ]);
  const detailedRef = profiles[0].models[1].ref;
  expect(detailedRef).not.toBe("quick");
  await renamed
    .getByRole("combobox", { name: "Reasoning effort" })
    .selectOption("disabled");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "model-configurations.json",
    mimeType: "application/json",
    buffer: exported,
  });
  await expect(
    renamed.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveValue("automatic");

  await dialog
    .getByRole("button", { name: "Model Roles", exact: true })
    .click();
  const story = dialog.getByRole("group", { name: "story", exact: true });
  const plugin = dialog.getByRole("group", { name: "plugin", exact: true });
  await story
    .getByRole("combobox", { name: "Model configuration", exact: true })
    .selectOption({ label: "Detailed story · Thinking on" });
  await expect(
    plugin.getByRole("combobox", { name: "Model configuration", exact: true }),
  ).toHaveValue("quick");
  await page.keyboard.press("Escape");
  await page.reload();
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  await dialog
    .getByRole("button", { name: "Model Roles", exact: true })
    .click();
  await expect(
    story.getByRole("combobox", { name: "Model configuration", exact: true }),
  ).toHaveValue(detailedRef);
  await expect(
    plugin.getByRole("combobox", { name: "Model configuration", exact: true }),
  ).toHaveValue("quick");
  await story.getByRole("button", { name: /Generation parameters/ }).click();
  await plugin.getByRole("button", { name: /Generation parameters/ }).click();
  await expect(
    story.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveValue("");
  await expect(
    story
      .getByText("Thinking on", { exact: true })
      .and(page.locator(":not(option)")),
  ).toHaveCount(2);
  await expect(
    plugin
      .getByText("Thinking off", { exact: true })
      .and(page.locator(":not(option)")),
  ).toHaveCount(2);
});
