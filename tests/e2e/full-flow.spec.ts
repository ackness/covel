import { test, expect } from "@playwright/test";
import { seedAppSettings, selectWorldByText } from "./helpers/player.js";

// Run serially to avoid rate-limiting from the server
test.describe.configure({ mode: "serial" });

test.describe("Covel Full Flow", () => {
  // Ensure viewport is wide enough for desktop nav (hidden md:flex)
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await seedAppSettings(page);
  });

  test("health API responds", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.status).toBe("ok");
  });

  test("worlds API returns seed data", async ({ request }) => {
    const response = await request.get("/api/worlds");
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    const worlds = data.items;
    expect(Array.isArray(worlds)).toBeTruthy();
    expect(worlds.length).toBeGreaterThanOrEqual(1);

    for (const world of worlds) {
      expect(world.id).toBeTruthy();
      expect(world.name).toBeTruthy();
    }
  });

  test("plugins API returns loaded plugins", async ({ request }) => {
    const response = await request.get("/api/plugins");
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data.items)).toBeTruthy();
    expect(data.items.length).toBeGreaterThanOrEqual(1);
  });

  test("the root opens the world list", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/session$/);
    await expect(page.getByText(/个世界|worlds/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("navigation header links work", async ({ page }) => {
    await page.goto("/session");

    // The primary nav is the top bar or, in rail layouts, the nav rail.
    const debugLink = page
      .getByRole("button", { name: /^(debug|调试)$/i })
      .filter({ visible: true })
      .first();
    await expect(debugLink).toBeVisible();

    // Debug link → /debug
    await debugLink.click();
    await expect(page).toHaveURL(/\/debug/);

    // The brand link returns to the world list. It sits in the top bar or,
    // in rail layouts, in the nav rail.
    await page.getByRole("link", { name: "Covel", exact: true }).click();
    await expect(page).toHaveURL(/\/session/);
  });

  test("world select screen loads with worlds", async ({ page }) => {
    await page.goto("/session");

    await expect(page.getByText(/个世界|worlds/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", {
        name: /雾港・裂潮纪|Mistport: The Riftide Chronicle/i,
      }),
    ).toBeVisible();
  });

  test("select world → session prep screen", async ({ page }) => {
    await page.goto("/session");

    await selectWorldByText(
      page,
      /雾港・裂潮纪|Mistport: The Riftide Chronicle/i,
    );

    // Prep screen should show world info and action buttons
    await expect(
      page
        .locator("button")
        .filter({ has: page.locator("svg") })
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText(/雾港・裂潮纪|Mistport: The Riftide Chronicle/i).first(),
    ).toBeVisible();
  });

  test("theme toggle works", async ({ page }) => {
    await page.goto("/session");

    const html = page.locator("html");
    const initialClass = await html.getAttribute("class");

    // The toggle sits in the top bar or, in rail layouts, the nav rail.
    const themeToggle = page
      .getByRole("button", { name: /dark mode|深色模式/i })
      .filter({ visible: true })
      .first();
    await expect(themeToggle).toBeVisible();
    await themeToggle.click();

    await expect.poll(() => html.getAttribute("class")).not.toBe(initialClass);
  });

  test("language selector switches locale", async ({ page }) => {
    // Inside the app the language is a setting; on a phone the menu dialog
    // also carries the select.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/session");

    await page.getByRole("button", { name: /primary|主导航/i }).click();
    const localeSelect = page.getByRole("combobox", {
      name: /language|语言/i,
    });
    await expect(localeSelect).toBeVisible();
    await expect(localeSelect).toHaveValue("zh-CN");
    await localeSelect.selectOption("en-US");

    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  });
});
