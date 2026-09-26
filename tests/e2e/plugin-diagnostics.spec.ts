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
