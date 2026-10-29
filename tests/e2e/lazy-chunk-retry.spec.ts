import { expect, test } from "@playwright/test";
import {
  composerInput,
  seedAppSettings,
  selectWorldByText,
  startGame,
  useServerWorlds,
} from "./helpers/player.js";

// A server restart or a dropped connection can cut a code-split chunk
// mid-download. The game view must load on the browser's next attempt
// instead of leaving the player on the error screen until a full reload.
test("the game view loads after its chunk download fails once", async ({
  page,
}) => {
  let failed = 0;
  await page.route(/\/assets\/game-view-[^/]+\.js$/, async (route) => {
    if (failed === 0) {
      failed++;
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await seedAppSettings(page);
  await useServerWorlds(page);
  await page.goto("/session");
  await selectWorldByText(page, /雾港|Mistport/i);
  await startGame(
    page,
    page.getByRole("button", { name: /^(开始游戏|Start game)$/i }).first(),
  );

  await expect(composerInput(page)).toBeVisible({ timeout: 20_000 });
  expect(failed).toBe(1);
  await expect(page.getByText("渲染此视图时发生错误。")).toHaveCount(0);
});
