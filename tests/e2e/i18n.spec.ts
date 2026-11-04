import { test, expect } from "@playwright/test";
import {
  seedBrowserSettings,
  ONBOARDING_VERSION,
  useIsolatedBrowserSettings,
} from "./helpers/player.js";

/**
 * i18n persistence smoke tests.
 *
 * Covers:
 *   1. unified settings storage drives initial language on load
 *   2. empty settings storage falls back to registry default
 *   3. the menu's selector supports a third locale and persists across reload
 */

test.describe.configure({ mode: "serial" });

test.describe("Locale preference", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("stored locale wins on reload", async ({ page }) => {
    await seedBrowserSettings(page, {
      "ui.locale": "en-US",
    });
    await page.goto("/session");

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

  test("settings selector supports a third locale and persists across reload", async ({
    page,
  }) => {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "zh-CN",
    });
    // The language is a setting: Settings opens from the top bar.
    await page.goto("/session");
    const openSettings = () =>
      page
        .getByRole("navigation", { name: /primary|主导航|основное/i })
        .getByRole("button", { name: /^(设置|Settings|Настройки)$/ })
        .click();
    await openSettings();

    const localeSelect = page
      .getByRole("dialog")
      .getByRole("combobox", { name: /界面语言|interface language|язык/i });
    await expect(localeSelect).toBeVisible();
    await expect(localeSelect.locator("option")).toHaveCount(3);
    await localeSelect.selectOption("ru-RU");

    await expect(page.locator("html")).toHaveAttribute("lang", "ru-RU");

    // Force a fresh document — the stored locale should survive
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru-RU");
    await openSettings();
    await expect(localeSelect).toHaveValue("ru-RU");
  });
});
