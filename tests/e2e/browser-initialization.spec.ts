import { expect, test, type Page } from "@playwright/test";
import { seedAppSettings } from "./helpers/player.js";

async function worldLibrary(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/services/data-service.ts";
    const { getDataService } = await import(path);
    return getDataService().listWorlds();
  });
}

test("concurrent first visits share the catalog and deleting them survives both tabs reloading", async ({
  page,
  context,
}) => {
  const catalog = ["harbor", "academy", "relay"].map((id) => ({
    id: `initialization-${id}`,
    name: `Catalog ${id}`,
    description: "Synthetic initialization fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  await context.route("**/api/worlds", (route) =>
    route.fulfill({ json: { items: catalog } }),
  );
  // The first visit copies each catalog world's full record, not its summary.
  await context.route("**/api/worlds/*", (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-1)!,
    );
    const world = catalog.find((item) => item.id === id);
    return world
      ? route.fulfill({ json: world })
      : route.fulfill({ status: 404, json: { error: "World not found" } });
  });
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
  expect(firstWorlds.map((world) => world.id).sort()).toEqual(
    catalog.map((world) => world.id).sort(),
  );
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
