import { expect, test, type Page } from "@playwright/test";
import { seedAppSettings, useServerWorlds } from "./helpers/player.js";

const pluginId = "clickable-map";

/**
 * The client asks before a community plugin acts. An event needs two grants
 * the first time: one to emit it, one to run the runtime that answers it.
 */
async function authorize(page: Page, action: RegExp) {
  const dialog = page
    .getByRole("dialog", { name: /授权插件操作|Authorize/ })
    .filter({ hasText: action });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: /^(授权|Authorize)$/ }).click();
  await expect(dialog).toHaveCount(0);
}

test("a community map plugin draws itself, travels on a click, drafts a move and expands", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await seedAppSettings(page);
  await useServerWorlds(page);
  const created = await request.post("/api/sessions", {
    data: {
      worldId: "haruka-academy",
      locale: "zh-CN",
      plugins: [pluginId],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { id: sessionId } = (await created.json()) as { id: string };
  try {
    // Enabling a community package loads its server code: approve it once.
    const pending = await request.put(
      `/api/sessions/${sessionId}/plugins/${pluginId}`,
    );
    expect(pending.status()).toBe(202);
    const { approvalId } = (await pending.json()) as { approvalId: string };
    const decision = await request.post(
      `/api/approvals/${approvalId}/decision`,
      { data: { decision: "allow", scope: "session" } },
    );
    expect(decision.ok(), await decision.text()).toBeTruthy();
    const enabled = await request.put(
      `/api/sessions/${sessionId}/plugins/${pluginId}`,
    );
    expect(enabled.ok(), await enabled.text()).toBeTruthy();

    await page.goto(`/session?sid=${encodeURIComponent(sessionId)}`);
    await page.getByRole("tab", { name: "地图" }).click();

    // Opening the panel with no map yet makes the widget emit `map.opened`;
    // the plugin's own runtime answers by writing the starting map.
    await authorize(page, /event:map\.opened/);
    await authorize(page, /(task|任务) clickable-map\/chart/);
    const panel = page.getByRole("tabpanel", { name: "地图" });
    const map = panel.frameLocator("iframe").frameLocator("iframe");
    const place = (id: string) => map.locator(`[data-place="${id}"]`);
    await expect(place("docks")).toHaveAttribute("data-current", "true", {
      timeout: 30_000,
    });
    await expect(place("market")).toHaveAttribute("data-reachable", "true");
    await expect(place("archive")).toHaveAttribute("data-reachable", "false");
    await expect(map.locator("#status")).toContainText("码头");

    // The widget sits in a sandbox, yet it is drawn in the active scheme.
    expect(
      await map.locator("html").evaluate((root) => ({
        accent:
          getComputedStyle(root).getPropertyValue("--covel-accent").trim() !==
          "",
        scheme: root.dataset.covelScheme,
      })),
    ).toEqual({ accent: true, scheme: "dark" });

    // A click only says where the player wants to go. The move happens in
    // the plugin's `travel` runtime, and comes back as new data.
    await place("market").click();
    await authorize(page, /event:map\.location-selected/);
    await authorize(page, /(task|任务) clickable-map\/travel/);
    await expect(place("market")).toHaveAttribute("data-current", "true", {
      timeout: 30_000,
    });
    await expect(place("archive")).toHaveAttribute("data-reachable", "true");
    await expect(place("docks")).toHaveAttribute("data-visited", "true");

    // The plugin also reports the place through the session summary.
    await expect(
      page.getByRole("group", { name: /^(状态|Status)$/ }),
    ).toContainText("集市");

    // The other use of a click: hand the move to the story as a drafted line.
    await map.getByRole("button", { name: "写进行动：去档案馆" }).click();
    await expect(page.getByText("我动身前往档案馆。")).toBeVisible();

    // A map wants room: the same panel moves into the large dialog.
    await panel.getByRole("button", { name: "放大面板" }).click();
    const large = page.getByRole("dialog", { name: "地图" });
    await expect(
      large
        .frameLocator("iframe")
        .frameLocator("iframe")
        .locator('[data-place="market"]'),
    ).toHaveAttribute("data-current", "true");
    // While the dialog is open the column behind it is out of the
    // accessibility tree, so look for its note by text.
    await expect(page.getByText("这个面板正在大窗口里显示。")).toBeVisible();
  } finally {
    const cleanup = await request.delete(`/api/sessions/${sessionId}`);
    expect(cleanup.ok(), "map test session cleanup failed").toBeTruthy();
  }
});
