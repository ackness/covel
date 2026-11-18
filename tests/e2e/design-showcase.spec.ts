import { expect, test } from "@playwright/test";
import {
  ONBOARDING_VERSION,
  openAppSettings,
  seedBrowserSettings,
} from "./helpers/player.js";

test("design showcase switches languages and applies built-in theme schemes on a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/design-system.html");
  const locale = page.locator("#showcase-locale");
  const theme = page.locator("#showcase-theme");
  const root = page.locator("html");
  for (const [code, heading, send, navigation, tone] of [
    ["zh-CN", "设置与调试", "发送", "主导航", "需要确认"],
    ["en-US", "Settings and Debug", "Send", "Primary", "Confirmation needed"],
    [
      "ru-RU",
      "Настройки и отладчик",
      "Отправить",
      "Основное",
      "Нужно подтверждение",
    ],
  ] as const) {
    await locale.selectOption(code);
    await expect(root).toHaveAttribute("lang", code);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: send, exact: true }),
    ).toHaveCount(2);
    await expect(page.locator(".composition-nav")).toHaveAttribute(
      "aria-label",
      navigation,
    );
    await expect(page.locator('[data-copy="toneWarning"]')).toHaveText(tone);
    expect(await root.evaluate((element) => element.scrollWidth)).toBe(320);
  }

  await theme.selectOption("abyss");
  await expect(root).toHaveAttribute("data-scheme", "dark");
  await expect(page.locator('[data-scheme-btn="light"]')).toBeDisabled();
  await expect(page.locator("#scheme-locked-hint")).toBeVisible();
  expect(
    await page.locator("body").evaluate((element) => {
      const body = getComputedStyle(element);
      const root = getComputedStyle(document.documentElement);
      return body.backgroundColor === root.backgroundColor;
    }),
  ).toBe(true);
  await page.reload();
  await expect(root).toHaveAttribute("lang", "ru-RU");
  await expect(theme).toHaveValue("abyss");
  await theme.selectOption("paper");
  await page.locator('[data-scheme-btn="light"]').click();
  await expect(root).toHaveAttribute("data-scheme", "light");
});

test("the settings sample and application share the Paper palette and section marker", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/design-system.html");
  await page.locator("#showcase-theme").selectOption("paper");
  await page.locator('[data-scheme-btn="light"]').click();
  const styleOf = (element: Element) => ({
    marker: getComputedStyle(element, "::before").backgroundColor,
    markerWidth: getComputedStyle(element, "::before").width,
    height: getComputedStyle(element).minHeight,
    surface: getComputedStyle(document.documentElement)
      .getPropertyValue("--surface-rail")
      .trim(),
  });
  const sample = await page
    .locator(".settings-mock [aria-current=true]")
    .evaluate(styleOf);
  expect(sample.markerWidth).toBe("2px");
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.appearance": "paper",
    "ui.scheme": "light",
    "ui.locale": "zh-CN",
  });
  await page.goto("/session");
  await openAppSettings(page);
  const selected = page
    .getByRole("dialog")
    .locator('nav [aria-current="page"]');
  await expect(selected).toBeVisible();
  expect(await selected.evaluate(styleOf)).toEqual(sample);
});
