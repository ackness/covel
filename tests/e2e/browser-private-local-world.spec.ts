import { expect, test } from "@playwright/test";
import {
  composerInput,
  seedAppSettings,
  selectWorldByText,
  startGame,
} from "./helpers/player.js";

// The default E2E server is browser-private and lets the browser update its
// worlds, so the first sync marks the world edited. The server then keeps its
// own world record in the save it admits, and that record must still be JSON.
test("a browser-private game starts from a local world the browser synced", async ({
  page,
}) => {
  const failedUploads: number[] = [];
  page.on("response", (response) => {
    if (
      response.request().method() === "PUT" &&
      response.url().endsWith("/browser-checkpoint") &&
      !response.ok()
    )
      failedUploads.push(response.status());
  });
  await seedAppSettings(page);
  await page.goto("/session");
  await selectWorldByText(page, /雾港|Mistport/i);
  await startGame(
    page,
    page.getByRole("button", { name: /^(开始游戏|Start game)$/i }).first(),
  );

  await expect(composerInput(page)).toBeVisible({ timeout: 20_000 });
  expect(failedUploads).toEqual([]);
});
