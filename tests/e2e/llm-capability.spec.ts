import { test, expect, type Page } from "@playwright/test";
import { seedBrowserSettings } from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

async function openModelRoles(page: Page) {
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  await page.getByRole("button", { name: "Model Roles", exact: true }).click();
  return page.getByRole("dialog");
}

test("partial capability overrides survive reopening and a failed lookup", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": 3,
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
