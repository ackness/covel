import { expect, test } from "@playwright/test";
import { createRecoveryFixture } from "./execution-recovery-fixtures.js";

test("/plugins opens session diagnostics with an optional plugin filter", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await createRecoveryFixture(page, "completed");
  try {
    await page.goto(`/session?sid=${fixture.id}`);
    const composer = page.getByTestId("game-composer-input");
    await expect(composer).toBeEnabled();
    await composer.fill("/plugins");
    await composer.press("Enter");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("view"))
      .toBe("plugins");
    expect(new URL(page.url()).searchParams.get("sid")).toBe(fixture.id);
    expect(new URL(page.url()).searchParams.has("pluginId")).toBe(false);
    await expect(page.getByRole("heading", { name: "插件诊断" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "guide" })).toBeVisible();

    await page.goto(`/session?sid=${fixture.id}`);
    await expect(composer).toBeEnabled();
    await composer.fill("/plugins guide");
    await composer.press("Enter");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("pluginId"))
      .toBe("guide");
    await expect(page.getByRole("heading", { name: "guide" })).toBeVisible();
    await expect(page.getByRole("button", { name: "显示全部" })).toBeVisible();
    expect(fixture.actions).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("plugin polling preserves the scroll position of the loaded list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await createRecoveryFixture(page, "completed");
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let reads = 0;
  await page.route(
    `**/api/sessions/${fixture.id}/plugin-diagnostics`,
    async (route) => {
      reads += 1;
      if (reads === 2) await refreshGate;
      await route.continue();
    },
  );
  try {
    await page.goto(`/debug?sid=${fixture.id}&view=plugins`);
    const panel = page.getByRole("region", { name: "插件", exact: true });
    await expect(panel).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "自动", exact: true }).click();
    const scrollTop = await panel.evaluate((element) => {
      element.scrollTop = 1200;
      return element.scrollTop;
    });
    expect(scrollTop).toBeGreaterThan(0);
    await expect(panel).toHaveAttribute("aria-busy", "true");
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(
      scrollTop,
    );
    releaseRefresh();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(
      scrollTop,
    );
  } finally {
    releaseRefresh();
    await fixture.dispose();
  }
});
