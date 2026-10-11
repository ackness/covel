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

  test("menu selector supports a third locale and persists across reload", async ({
    page,
  }) => {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "zh-CN",
    });
    // The language select sits in the menu dialog on a phone; inside the app
    // it is otherwise a setting.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/session");
    const openMenu = () =>
      page.getByRole("button", { name: /primary|主导航|основное/i }).click();
    await openMenu();

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
    await openMenu();
    await expect(localeSelect).toHaveValue("ru-RU");
  });
});
