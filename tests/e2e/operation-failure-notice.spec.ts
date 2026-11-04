import { expect, test } from "@playwright/test";
import { startPresentationBrowserHost } from "../../apps/server/tests/helpers/presentation-browser.js";
import {
  composerInput,
  seedAppSettings,
  waitForTurnIdle,
} from "./helpers/player.js";

test("preserves the story operation notice through reload and stage history without replaying the purchase", async ({
  page,
}) => {
  const host = await startPresentationBrowserHost("updated", {
    failOperation: true,
  });
  try {
    await seedAppSettings(page);
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/config/info")
        return route.fulfill({ json: { isDesktop: false } });
      if (url.pathname === "/api/health") {
        const health = await fetch(`${host.baseUrl}/api/health`).then(
          (response) => response.json(),
        );
        return route.fulfill({
          json: {
            ...health,
            storage: {
              ...health.storage,
              data: { ...health.storage?.data, frontendMode: "remote" },
            },
          },
        });
      }
      await route.continue({
        url: `${host.baseUrl}${url.pathname}${url.search}`,
      });
    });
    const hydration = ["view", "plugins"].map((resource) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/sessions/${host.sessionId}/${resource}` && response.ok(),
      ),
    );
    await page.goto(`/session?sid=${host.sessionId}`);
    await Promise.all(hydration);
    await expect(composerInput(page)).toBeVisible();
    await expect(page.getByTestId("notice-no-story-plugin")).toBeHidden();
    await composerInput(page).fill("Buy a book");
    await composerInput(page).press("Enter");
    await waitForTurnIdle(page);
    const footer = page.getByTestId("story-operation-failure-notice");
    await expect(footer).toHaveCount(1);
    await expect(footer).toHaveText("本回合有 1 个操作没有生效。");
    await expect(page.locator(".ui-narrative")).toContainText([
      "Public library story 1.",
    ]);
    const calls = host.calls();
    const turns = (await host.store.listTurnResults(host.sessionId)).length;
    await page.reload();
    await expect(footer).toHaveCount(1);
    await expect(composerInput(page)).toBeEnabled();
    await expect(page.locator(".ui-narrative")).toHaveCount(1);
    await page.getByRole("button", { name: "舞台", exact: true }).click();
    await expect(page.getByTestId("stage-choices")).toBeVisible();
    await expect(footer).toHaveCount(1);
    await expect(page.getByTestId("stage-decision-input")).toBeEnabled();
    await page.getByRole("button", { name: "履历", exact: true }).click();
    const history = page.getByRole("dialog");
    await expect(
      history.getByTestId("story-operation-failure-notice"),
    ).toHaveCount(1);
    await expect(history.locator(".ui-narrative")).toHaveCount(1);
    await expect(history.locator(".ui-narrative")).toHaveText(
      "Public library story 1.",
    );
    expect(host.calls()).toBe(calls);
    expect((await host.store.listTurnResults(host.sessionId)).length).toBe(
      turns,
    );
    expect(
      await host.store.listPluginData(
        host.sessionId,
        "purchase-probe",
        "purchases",
      ),
    ).toEqual([]);
  } finally {
    host.release();
    await page.goto("about:blank");
    await page.unrouteAll({ behavior: "wait" });
    await host.close();
  }
});
