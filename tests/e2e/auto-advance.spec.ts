import { expect, test } from "@playwright/test";
import { startAdvancementBrowserHost } from "../../apps/server/tests/helpers/auto-advance-browser.js";
import { composer, composerInput, seedAppSettings } from "./helpers/player.js";

for (const mode of ["chat", "stage"] as const) {
  test(`bounded advancement and Stop remain available in ${mode}`, async ({
    page,
  }) => {
    const host = await startAdvancementBrowserHost();
    try {
      await seedAppSettings(page);
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/config/info")
          return route.fulfill({ json: { isDesktop: false } });
        if (url.pathname === "/api/health") {
          const response = await fetch(`${host.baseUrl}/api/health`);
          const health = await response.json();
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
      await page.goto(`/session?sid=${host.sessionId}`);
      const controls = page.getByTestId("auto-advance-control");
      await expect(controls).toBeVisible();
      await composerInput(page).fill("Begin");
      await composerInput(page).press("Enter");
      await expect.poll(() => host.calls()).toBe(3);
      await expect(composer(page)).toHaveAttribute("data-executing", "false");
      await expect(page.locator(".ui-narrative")).toHaveCount(3);
      expect(
        (await host.store.getSession(host.sessionId))?.completedPlayerTurns,
      ).toBe(1);
      host.holdNextAuto();
      await composerInput(page).fill("Again");
      await composerInput(page).press("Enter");
      await expect(controls.getByRole("status")).toContainText("1 / 2");
      if (mode === "stage")
        await page
          .getByRole("button", { name: "舞台视图", exact: true })
          .click();
      await expect(
        controls.getByRole("button", { name: "停止推进" }),
      ).toBeVisible();
      await controls.getByRole("button", { name: "停止推进" }).click();
      await expect(controls.getByRole("status")).toHaveCount(0);
      expect(
        (await host.store.listMessages(host.sessionId)).filter(
          (message) => message.role === "assistant",
        ),
      ).toHaveLength(4);
      await page.reload();
      await expect(controls).toBeVisible();
      await expect(controls.getByRole("status")).toHaveCount(0);
      await controls.getByRole("combobox").selectOption("0");
      await expect
        .poll(
          async () =>
            (await host.store.getSession(host.sessionId))?.metadata
              ?.autoAdvanceLimit,
        )
        .toBe(0);
      await expect(controls.getByRole("combobox")).toHaveValue("0");

      // A fresh input interrupts automatic work, and refresh only recovers
      // its live controls. Neither operation replays a saved continue flag.
      await page.getByRole("button", { name: "解析视图", exact: true }).click();
      await controls.getByRole("combobox").selectOption("2");
      await expect(controls.getByRole("combobox")).toBeEnabled();
      host.holdNextAuto();
      await composerInput(page).fill("Keep going");
      await composerInput(page).press("Enter");
      await expect(controls.getByRole("status")).toContainText("1 / 2");
      await page.reload();
      await expect(controls.getByRole("status")).toContainText("1 / 2");
      if (mode === "stage")
        await page
          .getByRole("button", { name: "舞台视图", exact: true })
          .click();
      const freshInput =
        mode === "stage"
          ? page.getByTestId("stage-decision-input")
          : composerInput(page);
      await freshInput.fill("Change course");
      await freshInput.press("Enter");
      await expect.poll(() => host.calls()).toBe(10);
      await expect(controls.getByRole("status")).toHaveCount(0);
      const messages = await host.store.listMessages(host.sessionId);
      expect(
        messages.filter((message) => message.role === "assistant"),
      ).toHaveLength(8);
      expect(
        messages.filter(
          (message) =>
            message.role === "user" && message.content === "Change course",
        ),
      ).toHaveLength(1);
      expect(
        (await host.store.getSession(host.sessionId))?.completedPlayerTurns,
      ).toBe(4);

      // Leave a live chain and verify that its later completion cannot fill
      // the newly selected session's view.
      await page.getByRole("button", { name: "解析视图", exact: true }).click();
      host.holdNextAuto();
      await composerInput(page).fill("Continue after I leave");
      await composerInput(page).press("Enter");
      await expect(controls.getByRole("status")).toContainText("1 / 2");
      const response = await page.request.post(`${host.baseUrl}/api/sessions`, {
        data: {
          worldId: "advance-world",
          plugins: ["story-probe"],
          autoAdvanceLimit: 0,
          locale: "en-US",
        },
      });
      expect(response.ok()).toBe(true);
      const next = (await response.json()) as { id: string };
      await host.store.updateSession(next.id, { phase: "playing" });
      await page.goto(`/session?sid=${next.id}`);
      await expect(controls.getByRole("combobox")).toHaveValue("0");
      host.release();
      await expect.poll(() => host.calls()).toBe(13);
      await expect
        .poll(async () => {
          const response = await fetch(
            `${host.baseUrl}/api/sessions/${host.sessionId}/execution`,
          );
          return ((await response.json()) as { state: string }).state;
        })
        .toBe("completed");
      await expect(controls.getByRole("status")).toHaveCount(0);
      await expect(page.locator(".ui-narrative")).toHaveCount(0);
    } finally {
      host.release();
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "wait" });
      await host.close();
    }
  });
}
