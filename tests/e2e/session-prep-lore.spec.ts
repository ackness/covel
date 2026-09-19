import { expect, test } from "@playwright/test";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  useServerWorlds,
} from "./helpers/player.js";

for (const mode of ["local", "remote"] as const) {
  test(`prep captures session lore despite draft failure and later edits (${mode})`, async ({
    page,
  }) => {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.locale": "en-US",
    });
    if (mode === "remote") await useServerWorlds(page);
    await page.goto("/session");
    await expect(page.locator("article").first()).toBeVisible();
    const name = `Lore fixture ${crypto.randomUUID()}`;
    const worldId = await page.evaluate(async (name) => {
      const servicePath = "/src/services/data-service.ts";
      const draftPath = "/src/services/api/overlay.ts";
      const { getDataService } = await import(servicePath);
      const { setWorldOverlay } = await import(draftPath);
      const service = getDataService();
      const world = await service.createWorld(
        name,
        "Synthetic draft lifecycle fixture",
      );
      await service.updateWorld(world.id, {
        lore: "Original fixture lore",
        locale: "en-US",
        metadata: { requiredPlugins: ["pregame"] },
      });
      await setWorldOverlay(world.id, {
        lore: "",
        updatedAt: new Date().toISOString(),
      });
      return world.id;
    }, name);
    try {
      await page.reload();
      await page
        .locator("article")
        .filter({ hasText: name })
        .getByRole("button", { name: "Enter", exact: true })
        .click();
      await page.getByRole("button", { name: /World Document/ }).click();
      const input = page.getByRole("textbox", { name: "World Document" });
      await expect(input).toHaveValue("");

      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          if (this.name === "worldOverlays") {
            IDBObjectStore.prototype.put = put;
            throw new DOMException(
              "Synthetic quota failure",
              "QuotaExceededError",
            );
          }
          return key === undefined
            ? put.call(this, value)
            : put.call(this, value, key);
        };
      });
      const selectedLore = `Selected ${mode} session lore`;
      await input.fill(selectedLore);
      await expect(page.getByRole("alert")).toContainText("Draft not saved");
      await page
        .getByRole("button", { name: "Start Game", exact: true })
        .click();
      await expect(page).toHaveURL(/sid=/);
      const sessionId = new URL(page.url()).searchParams.get("sid")!;
      const persistedLore = () =>
        page.evaluate(async (sessionId) => {
          const apiPath = "/src/services/api.ts";
          const { getSession } = await import(apiPath);
          return (await getSession(sessionId)).metadata?.loreOverride;
        }, sessionId);
      expect(await persistedLore()).toBe(selectedLore);

      await page.evaluate(async (worldId) => {
        const draftPath = "/src/services/api/overlay.ts";
        const servicePath = "/src/services/data-service.ts";
        const { setWorldOverlay } = await import(draftPath);
        const { getDataService } = await import(servicePath);
        await setWorldOverlay(worldId, {
          lore: "Draft for a future session",
          updatedAt: new Date().toISOString(),
        });
        await getDataService().updateWorld(worldId, {
          lore: "Later world edit",
        });
      }, worldId);
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Begin Adventure", exact: true }),
      ).toBeVisible();
      expect(await persistedLore()).toBe(selectedLore);
      const requests: Array<{
        type: string;
        payload: Record<string, unknown>;
      }> = [];
      await page.route("**/api/actions", async (route) => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
          status: 503,
          json: { error: "Synthetic stop before model execution" },
        });
      });
      await page
        .getByRole("button", { name: "Begin Adventure", exact: true })
        .click();
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]).toMatchObject({ type: "start_session", payload: {} });
      expect(requests[0]?.payload).not.toHaveProperty("loreOverride");
      expect(await persistedLore()).toBe(selectedLore);
    } finally {
      await page.evaluate(
        async ({ worldId, mode }) => {
          const servicePath = "/src/services/data-service.ts";
          const apiPath = "/src/services/api.ts";
          const draftPath = "/src/services/api/overlay.ts";
          const { getDataService } = await import(servicePath);
          const { deleteWorld } = await import(apiPath);
          const { removeWorldOverlay } = await import(draftPath);
          const service = getDataService();
          for (const session of await service.listSessions(worldId))
            await service.deleteSession(session.id);
          await service.deleteWorld(worldId);
          if (mode === "local") await deleteWorld(worldId);
          await removeWorldOverlay(worldId);
        },
        { worldId, mode },
      );
    }
  });
}
