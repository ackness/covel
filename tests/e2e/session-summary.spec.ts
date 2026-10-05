import { expect, test } from "@playwright/test";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  selectWorldByText,
  useServerWorlds,
} from "./helpers/player.js";

for (const [locale, itemName] of [
  ["en-US", "Field radio"],
  ["zh-CN", "野战无线电"],
] as const) {
  test(`bundled plugins put the objective and the pack into the status strip in ${locale}`, async ({
    page,
  }) => {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": locale,
    });
    await useServerWorlds(page);
    await page.goto("/session");
    // Emberback seeds quests and opening gear, so the summary has content
    // before the first turn.
    await selectWorldByText(page, /Emberback|余烬背/i);
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
      await expect(strip).toContainText(itemName);
      const response = await page.request.get(`/api/sessions/${sessionId}`);
      expect(response.ok()).toBeTruthy();
      expect((await response.json()).locale).toBe(locale);
    } finally {
      const cleanup = await page.request.delete(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      expect(cleanup.ok(), "summary test session cleanup failed").toBeTruthy();
    }
  });
}
