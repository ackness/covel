import { test, expect } from "@playwright/test";

// Run serially to avoid rate-limiting from the server
test.describe.configure({ mode: "serial" });

test.describe("Covel Full Flow", () => {
  // Ensure viewport is wide enough for desktop nav (hidden md:flex)
  test.use({ viewport: { width: 1280, height: 720 } });

  test("health API responds", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.status).toBe("ok");
  });

  test("worlds API returns seed data", async ({ request }) => {
    const response = await request.get("/worlds");
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
    expect(data.length).toBeGreaterThanOrEqual(1);

    for (const world of data) {
      expect(world.id).toBeTruthy();
      expect(world.name).toBeTruthy();
    }
  });

  test("packages API returns loaded plugins", async ({ request }) => {
    const response = await request.get("/packages");
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data.packages)).toBeTruthy();
    expect(data.packages.length).toBeGreaterThanOrEqual(1);
  });

  test("landing page loads", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("h1")).toContainText("AI RPG");
    await expect(page.locator("header a", { hasText: "COVEL" })).toBeVisible();

    // Tech stack cards
    await expect(page.locator("text=Vite 8")).toBeVisible();
    await expect(page.locator("text=React 19")).toBeVisible();
    await expect(page.locator("text=Hono")).toBeVisible();
    await expect(page.locator("text=Drizzle")).toBeVisible();
  });

  test("navigate to studio via Get Started", async ({ page }) => {
    await page.goto("/");

    const getStarted = page.locator("header a[href='/session']").first();
    await getStarted.click();
    await expect(page).toHaveURL(/\/session/);
  });

  test("navigation header links work", async ({ page }) => {
    await page.goto("/");

    // nav links use hidden md:flex — viewport is 1280px so they should be visible
    const navLinks = page.locator("nav a");
    await expect(navLinks.first()).toBeVisible();

    // First nav link → /session
    await navLinks.first().click();
    await expect(page).toHaveURL(/\/session/);

    // Back to home
    await page.locator("header a", { hasText: "COVEL" }).click();
    await expect(page).toHaveURL("/");

    // Second nav link → /debug
    await navLinks.nth(1).click();
    await expect(page).toHaveURL(/\/debug/);
  });

  test("world select screen loads with worlds", async ({ page }) => {
    await page.goto("/session");

    const worldCards = page.locator("div[class*=cursor-pointer] h2");
    await expect(worldCards.first()).toBeVisible({ timeout: 15_000 });

    const count = await worldCards.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("select world → session prep screen", async ({ page }) => {
    await page.goto("/session");

    const worldCards = page.locator("div[class*=cursor-pointer]").filter({
      has: page.locator("h2"),
    });
    await expect(worldCards.first()).toBeVisible({ timeout: 15_000 });

    const worldName = await worldCards.first().locator("h2").textContent();
    await worldCards.first().click();

    // Prep screen should show world info and action buttons
    await expect(
      page.locator("button").filter({ has: page.locator("svg") }).first(),
    ).toBeVisible({ timeout: 10_000 });

    if (worldName) {
      await expect(page.getByText(worldName).first()).toBeVisible();
    }
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

    // Language toggle: a <button> in header with exactly "EN" or "中"
    const langButton = page.locator("header button", {
      hasText: /^(EN|中)$/,
    });
    await expect(langButton).toBeVisible();

    const initialText = await langButton.textContent();
    await langButton.click();

    const newText = await langButton.textContent();
    expect(newText).not.toBe(initialText);
  });
});
