import { test, expect } from "@playwright/test";

/**
 * i18n persistence smoke tests.
 *
 * Covers:
 *   1. unified settings storage drives initial language on load
 *   2. empty settings storage falls back to registry default
 *   3. header toggle persists across reload
 */

test.describe.configure({ mode: "serial" });

test.describe("Locale preference", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("stored locale wins on reload", async ({ page }) => {
    // Seed localStorage before first document load, then navigate.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "covel:settings",
        JSON.stringify({
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          entries: {
            "ui.locale": "en-US",
          },
        }),
      );
    });
    await page.goto("/");

    await expect(
      page.getByRole("link", { name: /start playing/i }).first(),
    ).toBeVisible();

    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "en-US");
  });

  test("empty settings uses registry default locale", async ({ browser }) => {
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem("covel:settings");
      } catch {
        // storage may be unavailable
      }
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await context.close();
  });

  test("header toggle persists across reload", async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.localStorage.getItem("covel:settings")) {
        window.localStorage.setItem(
          "covel:settings",
          JSON.stringify({
            schemaVersion: 1,
            savedAt: new Date().toISOString(),
            entries: {
              "ui.locale": "zh-CN",
            },
          }),
        );
      }
    });
    await page.goto("/");

    const toggle = page.locator("header button", { hasText: /^EN$/ });
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");

    // Force a fresh document — the stored locale should survive
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  });
});
