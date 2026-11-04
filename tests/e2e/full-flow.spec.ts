import { test, expect } from "@playwright/test";
import {
  chooseColorScheme,
  seedAppSettings,
  selectWorldByText,
} from "./helpers/player.js";

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
    // Debugger is for developers: it appears once Developer mode is on.
    const debugLink = page
      .getByRole("button", { name: /^(debugger|调试)$/i })
      .filter({ visible: true })
      .first();
    await expect(debugLink).toHaveCount(0);
    await page
      .getByRole("navigation", { name: /primary|主导航/i })
      .getByRole("button", { name: /^(设置|Settings)$/ })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("switch", { name: /开发者模式|developer mode/i })
      .click();
    await page.keyboard.press("Escape");
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

  test("color scheme setting works", async ({ page }) => {
    await page.goto("/session");

    const html = page.locator("html");
    const initialClass = await html.getAttribute("class");

    // The color scheme is a setting, opened from the top bar.
    await chooseColorScheme(
      page,
      initialClass?.includes("dark") ? "light" : "dark",
    );

    await expect.poll(() => html.getAttribute("class")).not.toBe(initialClass);
  });

  test("language selector switches locale", async ({ page }) => {
    // The language is a setting, opened from the top bar.
    await page.goto("/session");

    await page
      .getByRole("navigation", { name: /primary|主导航/i })
      .getByRole("button", { name: /^(设置|Settings)$/ })
      .click();
    const localeSelect = page
      .getByRole("dialog")
      .getByRole("combobox", { name: /界面语言|interface language/i });
    await expect(localeSelect).toBeVisible();
    await expect(localeSelect).toHaveValue("zh-CN");
    await localeSelect.selectOption("en-US");

    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  });
});
