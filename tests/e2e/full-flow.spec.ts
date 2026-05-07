import { test, expect } from "@playwright/test";

// Run serially to avoid rate-limiting from the server
test.describe.configure({ mode: "serial" });

test.describe("Covel Full Flow", () => {
  // Ensure viewport is wide enough for desktop nav (hidden md:flex)
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "covel:settings",
        JSON.stringify({
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          entries: {
            "ui.onboardedVersion": 3,
            "ui.locale": "zh-CN",
          },
        }),
      );
    });
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

  test("packages API returns loaded plugins", async ({ request }) => {
    const response = await request.get("/api/plugins");
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data.plugins)).toBeTruthy();
    expect(data.plugins.length).toBeGreaterThanOrEqual(1);
  });

  test("landing page loads", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("h1")).toContainText(/构建世界|Build worlds/i);
    await expect(page.locator("header a", { hasText: "COVEL" })).toBeVisible();

    await expect(
      page.getByRole("link", { name: /开始游玩|Start playing/i }).first(),
    ).toBeVisible();
    await expect(page.getByText(/插件系统|Plugin System/i)).toBeVisible();
    await expect(page.getByText(/回合流程|Turn Flow/i)).toBeVisible();
  });

  test("navigate to studio via Get Started", async ({ page }) => {
    await page.goto("/");

    const getStarted = page.locator("header a[href='/session']").first();
    await getStarted.click();
    await expect(page).toHaveURL(/\/session/);
  });

  test("navigation header links work", async ({ page }) => {
    await page.goto("/");

    const sessionLink = page.locator("header a[href='/session']").first();
    const debugLink = page
      .locator("header button", { hasText: /debug|调试/i })
      .first();
    await expect(sessionLink).toBeVisible();
    await expect(debugLink).toBeVisible();

    // Session link → /session
    await sessionLink.click();
    await expect(page).toHaveURL(/\/session/);

    // Back to home
    await page.locator("header a", { hasText: "COVEL" }).click();
    await expect(page).toHaveURL("/");

    // Debug link → /debug
    await debugLink.click();
    await expect(page).toHaveURL(/\/debug/);
  });

  test("world select screen loads with worlds", async ({ page }) => {
    await page.goto("/session");

    await expect(page.getByText(/个世界|worlds/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { name: /遥风学园|HARUKA-ACADEMY/i }),
    ).toBeVisible();
  });

  test("select world → session prep screen", async ({ page }) => {
    await page.goto("/session");

    const worldCard = page
      .getByRole("heading", { name: /遥风学园|HARUKA-ACADEMY/i })
      .locator("xpath=ancestor::article[1]");
    await expect(worldCard).toBeVisible({ timeout: 15_000 });
    await worldCard.click();

    // Prep screen should show world info and action buttons
    await expect(
      page
        .locator("button")
        .filter({ has: page.locator("svg") })
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText(/遥风学园|HARUKA-ACADEMY/i).first(),
    ).toBeVisible();
  });

  test("theme toggle works", async ({ page }) => {
    await page.goto("/");

    const html = page.locator("html");
    const initialClass = await html.getAttribute("class");

    const themeToggle = page.locator('header button[data-size="icon"]').first();
    await expect(themeToggle).toBeVisible();
    await themeToggle.click();

    const newClass = await html.getAttribute("class");
    expect(newClass).not.toBe(initialClass);
  });

  test("language toggle switches locale", async ({ page }) => {
    await page.goto("/");

    // Language toggle: a <button> in header with exactly "EN" or "ZH"
    const langButton = page.locator("header button", {
      hasText: /^(EN|ZH)$/,
    });
    await expect(langButton).toBeVisible();

    const initialText = await langButton.textContent();
    await langButton.click();

    const newText = await langButton.textContent();
    expect(newText).not.toBe(initialText);
  });
});
