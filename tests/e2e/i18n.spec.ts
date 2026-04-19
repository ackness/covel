import { test, expect } from "@playwright/test";

/**
 * i18n persistence + detection smoke tests.
 *
 * Covers:
 *   1. localStorage override drives initial language on load
 *   2. navigator.language drives initial language when no override set
 *   3. Header toggle persists across reload
 */

test.describe.configure({ mode: "serial" });

test.describe("Locale preference", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("stored locale wins on reload", async ({ page }) => {
    // Seed localStorage before first document load, then navigate.
    await page.addInitScript(() => {
      window.localStorage.setItem("covel:locale", "en-US");
    });
    await page.goto("/");

    const studio = page.getByRole("link", { name: /studio/i });
    await expect(studio).toBeVisible();

    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "en-US");
  });

  test("navigator.language seeds locale when storage is empty", async ({ browser }) => {
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem("covel:locale");
      } catch {
        // storage may be unavailable
      }
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await context.close();
  });

  test("header toggle persists across reload", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("covel:locale", "zh-CN");
    });
    await page.goto("/");

    const toggle = page.getByRole("button", { name: /^EN$/ });
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");

    // Force a fresh document — the stored locale should survive
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  });
});
