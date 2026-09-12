import { test, expect, type Page } from "@playwright/test";
import { seedBrowserSettings } from "./helpers/player.js";

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
    "ui.onboardedVersion": 3,
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

test("provider import keeps valid profiles alongside malformed legacy entries", async ({
  page,
}) => {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": 3,
    "ui.locale": "en-US",
  });
  await page.goto("/session");
  const dialog = await openSettings(page);
  await dialog.getByLabel("Import", { exact: true }).setInputFiles({
    name: "synthetic-providers.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([
        {
          id: "broken-url",
          name: "Broken URL",
          provider: "synthetic",
          model: "broken",
          baseUrl: 42,
        },
        {
          id: "broken-protocol",
          name: "Broken protocol",
          provider: "synthetic",
          model: "broken",
          protocol: {},
        },
        {
          id: "legacy-model",
          name: "Legacy",
          provider: "synthetic",
          model: "legacy",
        },
        {
          id: "current",
          name: "Current",
          baseUrl: "",
          models: [{ ref: "current-model", modelId: "current" }],
        },
      ]),
    ),
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem("covel:settings")!);
        return settings.entries["llm.providers"]
          ?.map((profile: { models: { ref: string }[] }) =>
            profile.models.map((model) => model.ref),
          )
          .flat()
          .sort();
      }),
    )
    .toEqual(["current-model", "legacy-model"]);
});
