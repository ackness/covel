import { expect, test, type Page } from "@playwright/test";
import { seedAppSettings } from "./helpers/player.js";

async function worldLibrary(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/services/data-service.ts";
    const { getDataService } = await import(path);
    return getDataService().listWorlds();
  });
}

test("concurrent first visits share samples and deleting them survives both tabs reloading", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  await seedAppSettings(page);
  await seedAppSettings(second);
  await Promise.all([page.goto("/session"), second.goto("/session")]);
  await expect(page.locator("article").first()).toBeVisible();
  await expect(second.locator("article").first()).toBeVisible();
  const [firstWorlds, secondWorlds] = await Promise.all([
    worldLibrary(page),
    worldLibrary(second),
  ]);
  expect(firstWorlds).toHaveLength(3);
  expect(secondWorlds.map((world) => world.id).sort()).toEqual(
    firstWorlds.map((world) => world.id).sort(),
  );
  await page.evaluate(
    async (ids) => {
      const path = "/src/services/data-service.ts";
      const { getDataService } = await import(path);
      for (const id of ids) await getDataService().deleteWorld(id);
    },
    firstWorlds.map((world) => world.id),
  );
  await Promise.all([page.reload(), second.reload()]);
  expect(await worldLibrary(page)).toEqual([]);
  expect(await worldLibrary(second)).toEqual([]);

  await second.evaluate(async () => {
    const path = "/src/services/data-service.ts";
    const { getDataService } = await import(path);
    await getDataService().createWorld("New user world", "Synthetic fixture");
  });
  await page.reload();
  expect((await worldLibrary(page)).map((world) => world.name)).toEqual([
    "New user world",
  ]);
  await second.close();
});
