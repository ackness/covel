import { test, expect, type Page, type Route } from "@playwright/test";
import { seedBrowserSettings, ONBOARDING_VERSION } from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

async function openModelRoles(page: Page) {
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  await page.getByRole("button", { name: "Model Roles", exact: true }).click();
  return page.getByRole("dialog");
}

test("model reasoning defaults and role overrides persist independently", async ({
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
            ref: "custom-qwen",
            modelId: "qwen3.8-flash",
            reasoningEffort: "disabled",
          },
        ],
      },
    ],
    "llm.slotConfig": { plugin: { modelRef: "custom-qwen" } },
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
  let dialog = await openModelRoles(page);
  let role = dialog.getByRole("group", { name: "plugin", exact: true });
  await role.getByRole("button", { name: /Generation parameters/ }).click();
  await expect(
    role.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveValue("");
  await expect(
    role
      .getByText("Thinking off", { exact: true })
      .and(page.locator(":not(option)")),
  ).toHaveCount(2);
  await role
    .getByRole("combobox", { name: "Reasoning effort" })
    .selectOption("provider-default");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("covel:settings")!).entries[
            "llm.paramOverrides"
          ]?.plugin?.reasoningEffort,
      ),
    )
    .toBe("provider-default");
  await page.keyboard.press("Escape");
  await page.reload();
  dialog = await openModelRoles(page);
  role = dialog.getByRole("group", { name: "plugin", exact: true });
  await role.getByRole("button", { name: /Generation parameters/ }).click();
  await expect(
    role.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveValue("provider-default");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("covel:settings")!).entries[
          "llm.providers"
        ][0].models[0].reasoningEffort,
    ),
  ).toBe("disabled");
  await role
    .getByRole("combobox", { name: "Reasoning effort" })
    .selectOption("");
  await expect(
    role
      .getByText("Thinking off", { exact: true })
      .and(page.locator(":not(option)")),
  ).toHaveCount(2);
});

test("frontend plugin models expose persistent generation settings independently of catalog limits", async ({
  page,
}) => {
  const metadataRequest = Promise.withResolvers<Route>();
  let lookups = 0;
  await page.route(
    "**/api/model-db",
    (route) => metadataRequest.resolve(route),
    { times: 1 },
  );
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
    "llm.providers": [
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.invalid",
        protocol: "openai-chat-v1",
        models: [{ ref: "custom-fixture", modelId: "fixture-model" }],
      },
    ],
    "llm.slotConfig": { plugin: { modelRef: "custom-fixture" } },
  });
  await page.route("**/api/llm-config", (route) =>
    route.fulfill({ json: { configured: false, providers: [], slots: {} } }),
  );
  await page.route("**/api/model-db/lookup**", (route) => {
    lookups += 1;
    return route.fulfill({
      json: {
        found: true,
        source: "model-database",
        pricingKind: "unknown",
        candidates: [],
        reasoning: null,
        capability: {
          input: ["text"],
          output: ["text"],
          contextWindow: 128_000,
          maxOutputTokens: 4096,
        },
      },
    });
  });
  await page.route("**/api/model-db/refresh", (route) =>
    route.fulfill({ json: { ok: true, count: 2, persisted: true } }),
  );
  await page.goto("/session");
  let dialog = await openModelRoles(page);
  let role = dialog.getByRole("group", { name: "plugin", exact: true });
  await role
    .getByRole("button", { name: "Edit Capabilities", exact: true })
    .click();
  const contextLimit = role.getByPlaceholder("128000", { exact: true });
  await contextLimit.fill("64000");
  const metadata = await metadataRequest.promise;
  await metadata.fulfill({
    json: { available: true, count: 1, updatedAt: "2026-09-19T00:00:00.000Z" },
  });
  await expect(
    dialog.getByText("1 models (LiteLLM)", { exact: true }),
  ).toBeVisible();
  await expect(contextLimit).toHaveValue("64000");
  await page.keyboard.press("Tab");
  await role.getByRole("button", { name: /Generation parameters/ }).click();
  const output = role.getByRole("spinbutton", { name: "Max Output Tokens" });
  await output.fill("32768");
  await output.press("Tab");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("covel:settings")!).entries[
            "llm.paramOverrides"
          ]?.plugin?.maxOutputTokens,
      ),
    )
    .toBe(32768);
  const previousLookups = lookups;
  await dialog
    .getByRole("button", { name: "Update from GitHub", exact: true })
    .click();
  await expect(
    dialog.getByText("2 models (LiteLLM)", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => lookups).toBeGreaterThan(previousLookups);
  await expect(
    role.getByRole("button", { name: /Generation parameters/ }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(output).toHaveValue("32768");
  await page.keyboard.press("Escape");
  await page.reload();
  dialog = await openModelRoles(page);
  role = dialog.getByRole("group", { name: "plugin", exact: true });
  await expect(role.getByText("ctx: 64K", { exact: true })).toBeVisible();
  await role.getByRole("button", { name: /Generation parameters/ }).click();
  await expect(
    role.getByRole("spinbutton", { name: "Max Output Tokens" }),
  ).toHaveValue("32768");
});

test("partial capability overrides survive reopening and a failed lookup", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
  });
  const capability = {
    input: ["text"],
    output: ["text"],
    contextWindow: 128_000,
  };
  await page.route("**/api/llm-config", (route) =>
    route.fulfill({
      json: {
        configured: true,
        providers: ["synthetic-provider"],
        slots: {
          story: {
            provider: "synthetic-provider",
            model: "synthetic-model",
            protocol: "openai-chat-v1",
            tag: "text",
            capability,
          },
        },
      },
    }),
  );
  let failLookup = false;
  const gate = Promise.withResolvers<void>();
  await page.route("**/api/model-db/lookup**", async (route) => {
    if (failLookup) {
      await gate.promise;
      await route.fulfill({ status: 400, json: { error: "Lookup failed" } });
      return;
    }
    await route.fulfill({
      json: {
        found: true,
        source: "known",
        pricingKind: "unknown",
        candidates: [],
        reasoning: null,
        capability,
      },
    });
  });

  try {
    await page.goto("/session");
    let dialog = await openModelRoles(page);
    await expect(dialog.getByText("ctx: 128K", { exact: true })).toBeVisible();
    await dialog
      .getByRole("button", { name: "Edit Capabilities" })
      .first()
      .click();
    await dialog.getByPlaceholder("128000", { exact: true }).fill("64000");
    await page.keyboard.press("Tab");
    await expect(dialog.getByText("ctx: 64K", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const settings = JSON.parse(localStorage.getItem("covel:settings")!);
          return settings.entries["llm.capabilityOverrides"]?.story;
        }),
      )
      .toEqual({ contextWindow: 64_000 });

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    dialog = await openModelRoles(page);
    await expect(dialog.getByText("ctx: 64K", { exact: true })).toBeVisible();

    failLookup = true;
    await page.reload();
    const lookupRequest = page.waitForRequest("**/api/model-db/lookup**");
    dialog = await openModelRoles(page);
    await lookupRequest;
    await expect(dialog.getByText("ctx: 64K", { exact: true })).toBeVisible();

    const failedLookup = page.waitForResponse(
      (response) =>
        response.url().includes("/api/model-db/lookup") &&
        response.status() === 400,
    );
    gate.resolve();
    await failedLookup;
    await dialog
      .getByRole("button", { name: "Edit Capabilities" })
      .first()
      .click();
    await expect(dialog.getByPlaceholder("64000", { exact: true })).toHaveValue(
      "64000",
    );
    expect(pageErrors).toEqual([]);
  } finally {
    gate.resolve();
  }
});
