import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  ONBOARDING_VERSION,
  openAppSettings,
  seedAppSettings,
  seedBrowserSettings,
} from "./helpers/player.js";

interface CatalogFixture {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

async function mockCatalog(
  target: Page | BrowserContext,
  getCatalog: () => readonly CatalogFixture[],
) {
  await target.route("**/api/worlds", (route) =>
    route.fulfill({ json: { items: getCatalog() } }),
  );
  await target.route("**/api/worlds/*", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const world = getCatalog().find(({ id }) => pathname.endsWith(`/${id}`));
    return world
      ? route.fulfill({ json: world })
      : route.fulfill({ status: 404, json: { error: "World not found" } });
  });
}

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
  await mockCatalog(context, () => catalog);
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

test("a replacement adds a fifth local world until the player resets browser game data", async ({
  page,
}) => {
  const fixtures = ["harbor", "academy", "tower", "relay", "train"].map(
    (id) => ({
      id: `refresh-${id}`,
      name: `Catalog ${id}`,
      description: "Synthetic catalog fixture",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  let catalog = fixtures.slice(0, 4);
  await mockCatalog(page, () => catalog);

  await seedAppSettings(page);
  await page.goto("/session");
  await expect(page.locator("article")).toHaveCount(4);
  catalog = [...fixtures.slice(0, 3), fixtures[4]!];
  await page.reload();
  await expect(page.locator("article")).toHaveCount(5);
  const draftWorldId = catalog[0]!.id;
  await page.evaluate(async (worldId) => {
    const path = "/src/services/app-kv-store.ts";
    const { setWorldOverlay } = await import(path);
    await setWorldOverlay(worldId, {
      lore: "Old draft",
      updatedAt: new Date().toISOString(),
    });
  }, draftWorldId);

  await openAppSettings(page);
  await page.getByRole("button", { name: "导入、备份与重置" }).click();
  const resetName = "重置浏览器游戏数据";
  await page.getByRole("button", { name: resetName }).click();
  const confirmation = page.getByRole("dialog", { name: resetName });
  await confirmation.getByRole("button", { name: "取消" }).click();
  expect(await worldLibrary(page)).toHaveLength(5);
  await page.getByRole("button", { name: resetName }).click();
  await Promise.all([
    page.waitForEvent("load"),
    confirmation.getByRole("button", { name: resetName }).click(),
  ]);
  await expect(page.locator("article")).toHaveCount(4);
  expect((await worldLibrary(page)).map(({ id }) => id).sort()).toEqual(
    catalog.map(({ id }) => id).sort(),
  );
  expect(
    await page.evaluate(async (worldId) => {
      const path = "/src/services/app-kv-store.ts";
      const { getWorldOverlay } = await import(path);
      return getWorldOverlay(worldId);
    }, draftWorldId),
  ).toBeNull();
});

const worldLayouts = [
  { appearance: "stage", layout: "showcase" },
  { appearance: "modern", layout: "covers" },
  { appearance: "panel", layout: "cards" },
  { appearance: "book", layout: "list" },
] as const;

for (const { appearance, layout } of worldLayouts) {
  test(`${layout} keeps a long library usable at desktop and phone widths`, async ({
    page,
  }) => {
    const longName = `ExtremelyLongWorldName${"WithoutSpaces".repeat(6)}`;
    const catalog = Array.from({ length: 9 }, (_, index) => ({
      id: `layout-world-${index}`,
      name: index === 0 ? longName : `Layout world ${index}`,
      description: "A world used to exercise the layout.",
      metadata: { cover: "media/gallery/cover.webp" },
      createdAt: new Date(Date.UTC(2026, 0, 9 - index)).toISOString(),
    }));
    await mockCatalog(page, () => catalog);
    await page.route("**/api/worlds/*/gallery/gallery/cover.webp", (route) =>
      route.fulfill({ status: 404 }),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": ONBOARDING_VERSION,
      "ui.appearance": appearance,
      "ui.locale": "en-US",
    });
    await page.goto("/session");
    await expect(page.locator("html")).toHaveAttribute(
      "data-world-list",
      layout,
    );
    const surface = page.locator(
      layout === "showcase" ? ".ui-world-showcase" : ".ui-world-select",
    );
    const items = surface.locator(
      layout === "showcase" ? ".ui-world-thumb" : "article",
    );
    await expect(items).toHaveCount(catalog.length);
    await expect(surface.locator("img").first()).toHaveAttribute(
      "src",
      "/visuals/backgrounds/studio-shell.webp",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 360, height: 760 });
    await expect
      .poll(() =>
        surface.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);

    if (layout === "showcase") {
      const rail = surface.locator(".ui-world-rail");
      await expect(rail).toHaveCSS("scroll-behavior", "auto");
      const first = items.first();
      const last = items.last();
      expect((await first.boundingBox())?.height).toBe(
        (await last.boundingBox())?.height,
      );
      await page.getByRole("button", { name: "All worlds (9)" }).click();
      const dialog = page.getByRole("dialog", { name: "All worlds (9)" });
      await dialog.getByRole("searchbox").fill("Layout world 8");
      await dialog.getByRole("button", { name: "Layout world 8" }).click();
      await expect(last).toHaveAttribute("aria-pressed", "true");
      await expect(last).toBeInViewport();
    } else {
      await surface.getByRole("searchbox").fill("Layout world 8");
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText("Layout world 8");
    }
  });
}
