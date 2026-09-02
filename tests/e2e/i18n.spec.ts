import { test, expect } from "@playwright/test";
import {
  seedBrowserSettings,
  useIsolatedBrowserSettings,
} from "./helpers/player.js";

/**
 * i18n persistence smoke tests.
 *
 * Covers:
 *   1. unified settings storage drives initial language on load
 *   2. empty settings storage falls back to registry default
 *   3. header selector supports a third locale and persists across reload
 */

test.describe.configure({ mode: "serial" });

test.describe("Locale preference", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("stored locale wins on reload", async ({ page }) => {
    await seedBrowserSettings(page, {
      "ui.locale": "en-US",
    });
    await page.goto("/");

    await expect(
      page.getByRole("link", { name: /start playing/i }).first(),
    ).toBeVisible();

    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "en-US");

    await page.reload();
    await expect(html).toHaveAttribute("lang", "en-US");
  });

  test("empty settings uses the browser locale as registry default", async ({
    browser,
  }) => {
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    await useIsolatedBrowserSettings(page);
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem("covel:settings");
      } catch {
        // storage may be unavailable
      }
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await context.close();
  });

  test("header selector supports a third locale and persists across reload", async ({
    page,
  }) => {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": 3,
      "ui.locale": "zh-CN",
    });
    await page.goto("/");

    const localeSelect = page.getByRole("combobox", {
      name: /language|语言|язык/i,
    });
    await expect(localeSelect).toBeVisible();
    await expect(localeSelect.locator("option")).toHaveCount(3);
    await localeSelect.selectOption("ru-RU");

    await expect(page.locator("html")).toHaveAttribute("lang", "ru-RU");

    // Force a fresh document — the stored locale should survive
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru-RU");
    await expect(localeSelect).toHaveValue("ru-RU");
  });
});
