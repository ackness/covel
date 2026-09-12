import { expect, test, type Page } from "@playwright/test";
import { createRecoveryFixture } from "./execution-recovery-fixtures.js";
import { seedAppSettings } from "./helpers/player.js";

async function navigateTopbar(page: Page, name: string, width: number) {
  if (width < 1024) {
    await page.getByRole("button", { name: "主导航", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: true })
      .click();
  } else {
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
  }
}

for (const width of [1512, 390]) {
  test(`cross-route plugin and lazy image navigation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await createRecoveryFixture(page, "completed");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/ui-specs?*", async (route) => {
      // Delay specs to exercise the gap between drawer mounting and discovery.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({
        json: {
          left: [],
          message: [],
          right: [
            {
              pluginId: "review-gallery",
              specs: [
                {
                  id: "gallery",
                  label: "Review gallery",
                  icon: "image",
                  alwaysRender: true,
                  view: {
                    component: "Text",
                    props: { content: "Gallery ready" },
                  },
                },
              ],
            },
          ],
        },
      });
    });
    await page.route(
      "**/api/sessions/*/plugin-data/review-gallery**",
      (route) => route.fulfill({ json: { items: [] } }),
    );
    try {
      await page.goto(`/session?sid=${fixture.id}`);
      await expect(page.getByTestId("game-composer")).toBeVisible();
      await navigateTopbar(page, "调试", width);
      await expect(page).toHaveURL(new RegExp(`/debug\\?sid=${fixture.id}`));
      await expect(page.getByText("§ TRACE", { exact: true })).toBeVisible();
      await navigateTopbar(page, "插件", width);
      await expect(
        page.getByRole("dialog", { name: /SETTINGS/ }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await navigateTopbar(page, "调试", width);
      await expect(page.getByText("§ TRACE", { exact: true })).toBeVisible();
      await navigateTopbar(page, "图像", width);
      await expect(
        page.getByRole("tab", { name: "Review gallery" }),
      ).toHaveAttribute("aria-selected", "true");
      expect(new URL(page.url()).searchParams.get("panel")).toBeNull();
      expect(errors).toEqual([]);
      expect(fixture.actions).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
}

test("debugger navigation opens the selected session and resets the previous composer", async ({
  page,
}) => {
  const first = await createRecoveryFixture(page, "completed");
  const second = await createRecoveryFixture(page, "completed");
  try {
    await page.goto(`/session?sid=${first.id}`);
    await expect(page.getByTestId("game-composer-input")).toBeVisible();
    await page
      .getByTestId("game-composer-input")
      .fill("Unsaved first-session draft");
    await navigateTopbar(page, "调试", 1280);
    await page.getByRole("button", { name: new RegExp(second.id) }).click();
    await expect(page).toHaveURL(new RegExp(`/debug\\?sid=${second.id}`));
    await navigateTopbar(page, "会话", 1280);
    await expect(page).toHaveURL(new RegExp(`/session\\?sid=${second.id}`));
    await expect(page.getByTestId("game-composer-input")).toBeVisible();
    await expect(page.getByTestId("game-composer-input")).toHaveValue("");
    expect(first.actions).toEqual([]);
    expect(second.actions).toEqual([]);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("browser world edits and cascading deletion survive reload without a server world", async ({
  page,
}) => {
  await seedAppSettings(page);
  await page.goto("/session");
  await expect(page.locator("article").first()).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = "/src/services/data-service.ts";
    const { getDataService } = await import(modulePath);
    const ds = getDataService();
    await ds.saveGeneratedWorld({
      id: "review-local-world",
      name: "Review local world",
      description: "Synthetic lifecycle fixture",
      dimensions: {
        geography: {
          overview: "Original overview",
          regions: [
            { name: "Harbor", description: "A quiet harbor", climate: "Mild" },
          ],
        },
      },
      createdAt: "2026-01-01T00:00:00Z",
    });
    await ds.createSession(
      "review-local-world",
      undefined,
      "review-local-session",
    );
  });
  await page.reload();
  const card = page
    .locator("article")
    .filter({ hasText: "Review local world" });
  await card.getByRole("button", { name: "查看详情" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .locator("#world-geography-overview")
    .fill("Edited browser overview");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Review local world", exact: true }),
  ).toBeVisible();
  await page.reload();
  await card.getByRole("button", { name: "查看详情" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.locator("#world-geography-overview")).toHaveValue(
    "Edited browser overview",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "删除世界", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "选择一个世界", exact: true }),
  ).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator("article").first()).toBeVisible();
  await expect(card).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const modulePath = "/src/services/data-service.ts";
      const { getDataService } = await import(modulePath);
      return getDataService().getSession("review-local-session");
    }),
  ).toBeNull();
});

test("portrait replacement reaches the runtime and survives a browser checkpoint reload", async ({
  page,
}) => {
  await seedAppSettings(page);
  await page.goto("/session");
  await expect(page.locator("article").first()).toBeVisible();
  const seeded = await page.evaluate(async () => {
    const dataPath = "/src/services/data-service.ts";
    const apiPath = "/src/services/api.ts";
    const { getDataService, getSessionWorkspace } = await import(dataPath);
    const { postPluginRpc } = await import(apiPath);
    const ds = getDataService();
    await ds.saveGeneratedWorld({
      id: "review-portrait-world",
      name: "Portrait review",
      description: "Synthetic media test",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await ds.createSession(
      "review-portrait-world",
      undefined,
      "review-portrait-session",
      ["character-presence"],
    );
    return getSessionWorkspace().run(
      "review-portrait-session",
      "seed-presence",
      () =>
        postPluginRpc("review-portrait-session", {
          kind: "runtime",
          pluginId: "character-presence",
          runtimeId: "character-presence",
          payload: {
            presence: {
              schemaVersion: 1,
              characterId: "review-hero",
              displayName: "Review hero",
            },
          },
        }),
    );
  });
  expect(seeded.status).toBe("ok");
  await page.goto("/session?sid=review-portrait-session");
  const portraits = page.getByRole("tab", { name: "角色立绘", exact: true });
  await portraits.click();
  await expect(page.getByText("Review hero", { exact: true })).toBeVisible();
  const rpc = page.waitForResponse(
    (response) =>
      response.url().endsWith("/plugin-rpc") &&
      response.request().method() === "POST",
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: "review-portrait.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  expect((await (await rpc).json()).status).toBe("ok");
  await expect(
    page.getByRole("img", { name: "Review hero", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const dataPath = "/src/services/storage/browser-vault.ts";
        const { BrowserVault } = await import(dataPath);
        const vault = new BrowserVault();
        try {
          const checkpoint = await vault.getCheckpoint(
            "review-portrait-session",
          );
          return !!checkpoint?.pluginData.find(
            (row: { key: string; value?: { avatar?: unknown } }) =>
              row.key === "review-hero",
          )?.value?.avatar;
        } finally {
          vault.close();
        }
      }),
    )
    .toBe(true);
  await page.reload();
  await portraits.click();
  const portrait = page.getByRole("img", { name: "Review hero", exact: true });
  await expect(portrait).toBeVisible();
  await expect
    .poll(() =>
      portrait.evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
});
