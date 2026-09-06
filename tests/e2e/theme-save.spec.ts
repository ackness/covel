import { test, expect, type Page } from "@playwright/test";
import { seedBrowserSettings } from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

async function openAppearance(page: Page) {
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("dialog").locator(".prose strong")).toBeVisible();
  return page.getByRole("dialog");
}

test("a saved aurora keeps motion after reload, export and import", async ({
  page,
}, testInfo) => {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": 3,
    "ui.locale": "en-US",
    "ui.appearance": "aurora",
    "ui.scheme": "dark",
  });
  await page.goto("/session");
  let dialog = await openAppearance(page);
  const readLight = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.body, "::after");
      return {
        gradient: style.backgroundImage,
        animation: style.animationName,
        duration: style.animationDuration,
        opacity: style.opacity,
      };
    });
  const original = await readLight();
  expect(original.gradient).toContain("conic-gradient");
  await dialog
    .getByRole("textbox", { name: "Save as theme package" })
    .fill("My aurora");
  await dialog.getByRole("button", { name: "Save as", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "my-aurora");
  await expect(
    dialog.getByRole("textbox", { name: "Save as theme package" }),
  ).toHaveValue("");
  await expect.poll(readLight).toMatchObject({
    gradient: original.gradient,
    duration: original.duration,
    opacity: original.opacity,
  });
  expect((await readLight()).animation).not.toBe("none");
  expect((await readLight()).animation).not.toBe(original.animation);
  // Saved tokens remain editable; the snapshot must not make them !important.
  await dialog
    .getByRole("textbox", { name: "Body color", exact: true })
    .and(dialog.locator('input[type="text"]'))
    .fill("#f4ead8");
  await expect(dialog.locator(".prose p").first()).toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );
  await dialog
    .getByRole("textbox", { name: "Save as theme package" })
    .fill("My aurora");
  await dialog.getByRole("button", { name: "Save as", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Save as theme package" }),
  ).toHaveValue("");
  await page.reload();
  dialog = await openAppearance(page);
  await expect.poll(readLight).toMatchObject({ gradient: original.gradient });
  await expect(dialog.locator(".prose p").first()).toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );

  await dialog.locator("summary").filter({ hasText: "Theme Library" }).click();
  const savedRow = dialog
    .locator(".ui-band")
    .filter({ has: page.getByText("My aurora", { exact: true }) });
  const downloadPromise = page.waitForEvent("download");
  await savedRow.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  await savedRow.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-theme",
    "my-aurora",
  );
  await dialog
    .locator('input[type="file"][accept*=".css"]')
    .setInputFiles(path);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "my-aurora");
  await expect.poll(readLight).toMatchObject({ gradient: original.gradient });
  await page.evaluate(() => {
    document.documentElement.dataset.turn = "executing";
  });
  await expect
    .poll(readLight)
    .toMatchObject({ duration: "14s", opacity: "0.9" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(readLight).toMatchObject({ animation: "none" });
});
