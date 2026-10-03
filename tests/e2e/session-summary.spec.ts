import { expect, test } from "@playwright/test";
import {
  seedAppSettings,
  selectWorldByText,
  useServerWorlds,
} from "./helpers/player.js";

test("bundled plugins put the objective and the pack into the status strip", async ({
  page,
}) => {
  await seedAppSettings(page);
  await useServerWorlds(page);
  await page.goto("/session");
  // Emberback seeds quests and opening gear, so the summary has content
  // before the first turn.
  await selectWorldByText(page, /Emberback/i);
  // It is an English world; the Chinese interface asks before entering.
  await page
    .getByRole("button", { name: /以英语继续|continue in english/i })
    .click();
  await page
    .getByRole("button", { name: /^(start game|开始游戏)$/i })
    .first()
    .click();
  await expect(page).toHaveURL(/sid=/, { timeout: 20_000 });
  const sessionId = new URL(page.url()).searchParams.get("sid")!;

  try {
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/sessions/${encodeURIComponent(sessionId)}/ui-slots?slot=session.summary@1`,
        );
        const { items } = (await response.json()) as {
          items: { value: { entries: { id: string }[] } | null }[];
        };
        return items[0]?.value?.entries.map((entry) => entry.id) ?? [];
      })
      .toEqual(expect.arrayContaining(["quest.current", "inventory.items"]));

    const strip = page.getByRole("group", { name: /^(状态|Status)$/ });
    await expect(strip).toContainText(/当前目标|Objective/);
    await expect(strip).toContainText(/行囊|Pack/);
    await expect(strip).toContainText("Field radio");
  } finally {
    const cleanup = await page.request.delete(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    );
    expect(cleanup.ok(), "summary test session cleanup failed").toBeTruthy();
  }
});
