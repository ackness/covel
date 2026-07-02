import { test, expect, type Page } from "@playwright/test";

/**
 * Stage view mode smoke — no LLM turn.
 *
 * The interactive e2e infra is real-LLM-gated (see game-session.spec), so per
 * the stage-mode plan this covers the viewMode plumbing without running a turn:
 *   1. haruka's world `defaultViewMode: stage` lands the game view in stage mode
 *   2. the header toggle switches between parsed and stage
 * Full stage-render visual regression (backdrop / sprites / typewriter over real
 * scene art) needs a committed turn and is verified manually.
 */

test.describe.configure({ mode: "serial" });

test.describe("Stage view mode", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "covel:settings",
        JSON.stringify({
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          entries: { "ui.onboardedVersion": 3, "ui.locale": "zh-CN" },
        }),
      );
    });
  });

  test("haruka defaultViewMode:stage applies and the toggle switches", async ({
    page,
  }) => {
    await enterFreshHarukaSession(page);

    const stageToggle = page.getByRole("button", {
      name: /舞台视图|Stage view/i,
    });
    const parsedToggle = page.getByRole("button", {
      name: /解析视图|Parsed view/i,
    });

    // world.yaml `defaultViewMode: stage` → stage is the initial mode on mount.
    await expect(stageToggle).toBeVisible({ timeout: 10_000 });
    await expect(stageToggle).toHaveAttribute("data-state", "on");

    // Toggle plumbing: parsed ↔ stage.
    await parsedToggle.click();
    await expect(stageToggle).toHaveAttribute("data-state", "off");
    await expect(parsedToggle).toHaveAttribute("data-state", "on");

    await stageToggle.click();
    await expect(stageToggle).toHaveAttribute("data-state", "on");

    await page.screenshot({ path: "debugs/e2e-logs/stage-toggle.png" });
  });
});

async function enterFreshHarukaSession(page: Page) {
  await page.goto("/session");

  const worldCard = page
    .getByRole("heading", { name: /遥风学园|HARUKA-ACADEMY/i })
    .locator("xpath=ancestor::article[1]");
  await expect(worldCard).toBeVisible({ timeout: 15_000 });
  await worldCard.click();

  const startButton = page.locator("button", {
    hasText: /start game|开始游戏/i,
  });
  await expect(startButton).toBeVisible({ timeout: 10_000 });
  await startButton.click();

  await expect(page).toHaveURL(/sid=/, { timeout: 15_000 });
}
