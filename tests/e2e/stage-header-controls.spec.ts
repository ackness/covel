import { expect, test } from "@playwright/test";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  startGame,
  useServerWorlds,
} from "./helpers/player.js";

// The stage appearance (the default for players) draws session header buttons
// as round glass. A button that keeps an icon width while showing words lets
// the words spill out of the circle and over its neighbour.
for (const width of [1280, 390]) {
  test(`session header buttons hold their labels in the stage appearance at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "zh-CN",
      "ui.appearance": "stage",
    });
    await useServerWorlds(page);
    await page.goto("/session");
    await page.getByRole("button", { name: /^进入/ }).first().click();
    await startGame(
      page,
      page.getByRole("button", { name: /^开始游戏$/ }).first(),
    );
    await expect(page).toHaveURL(/sid=/, { timeout: 20_000 });
    const sessionId = new URL(page.url()).searchParams.get("sid")!;
    try {
      const header = page.getByTestId("session-header");
      const controls = [
        header.getByRole("button", { name: "阅读", exact: true }),
        header.getByRole("button", { name: "舞台", exact: true }),
        header.getByRole("button", { name: "菜单", exact: true }),
        header.getByRole("button", { name: "侧栏", exact: true }),
      ];
      const boxes = [];
      for (const control of controls) {
        await expect(control).toBeVisible();
        const fits = await control.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return [...element.children].every((child) => {
            const inner = child.getBoundingClientRect();
            return (
              inner.width === 0 ||
              (inner.left >= box.left - 0.5 && inner.right <= box.right + 0.5)
            );
          });
        });
        expect(fits).toBe(true);
        boxes.push((await control.boundingBox())!);
      }
      for (let i = 1; i < boxes.length; i += 1)
        expect(boxes[i]!.x).toBeGreaterThanOrEqual(
          boxes[i - 1]!.x + boxes[i - 1]!.width - 0.5,
        );
    } finally {
      await page.request.delete(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
    }
  });
}
