import { test, expect, type Page } from "@playwright/test";
import { seedBrowserSettings, ONBOARDING_VERSION } from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

async function openSettings(page: Page) {
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  return page.getByRole("dialog");
}

test("malformed stored themes do not prevent appearance settings from loading", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
    "ui.appearance": "synthetic-valid",
    "ui.customThemes": [
      { id: "synthetic-valid", label: "Synthetic valid", cssText: "" },
      { id: "synthetic-invalid", label: null, cssText: "" },
      null,
    ],
  });
  await page.goto("/session");
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "synthetic-valid",
  );
  let dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await dialog.locator("summary").filter({ hasText: "Theme Library" }).click();
  await expect(
    dialog.getByText("Synthetic valid", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    dialog.getByText("synthetic-invalid", { exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "synthetic-valid",
  );
  dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(dialog.locator(".prose strong")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("provider import accepts current exports and rejects obsolete files without changing settings", async ({
  page,
}) => {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
  });
  await page.goto("/session");
  let dialog = await openSettings(page);
  const current = {
    id: "current",
    name: "Current",
    baseUrl: "https://current.example/v1",
    models: [{ ref: "current-model", modelId: "current" }],
  };
  const upload = async (value: unknown) => {
    await dialog.getByLabel("Import", { exact: true }).setInputFiles({
      name: "synthetic-providers.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)),
    });
  };
  const savedProfiles = () =>
    page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem("covel:settings")!);
      return settings.entries["llm.providers"];
    });
  await upload({
    version: 2,
    providers: [null, { id: "broken", models: "invalid" }, current],
  });
  await expect.poll(savedProfiles).toEqual([current]);

  await upload([
    { id: "obsolete", name: "Obsolete", provider: "old", model: "old" },
  ]);
  await expect(dialog.getByRole("alert")).toHaveText("Invalid settings file");
  expect(await savedProfiles()).toEqual([current]);

  const updated = {
    ...current,
    models: [...current.models, { ref: "second", modelId: "second" }],
  };
  await upload({ version: 2, providers: [updated] });
  await expect.poll(savedProfiles).toEqual([updated]);
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  await page.reload();
  dialog = await openSettings(page);
  expect(await savedProfiles()).toEqual([updated]);
  await expect(
    dialog.getByText("current", { exact: true }).first(),
  ).toBeVisible();
});
