import { test, expect, type Page } from "@playwright/test";
import { seedBrowserSettings } from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

async function openAppearance(page: Page) {
  await page
    .getByRole("button", { name: /Configure Providers & Models/i })
    .click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const preview = page.getByRole("dialog").locator(".prose");
  await expect(preview.locator("strong")).toBeVisible();
  return preview;
}

const themes = [
  { theme: "paper", scheme: "dark", size: "16px", lineHeight: "28.48px" },
  { theme: "paper", scheme: "light", size: "16px", lineHeight: "28.48px" },
  { theme: "modern", scheme: "dark", size: "17px", lineHeight: "30.6px" },
  { theme: "modern", scheme: "light", size: "17px", lineHeight: "30.6px" },
  { theme: "abyss", scheme: "dark", size: "17px", lineHeight: "30.6px" },
  { theme: "aurora", scheme: "dark", size: "16px", lineHeight: "28.8px" },
];

for (const { theme, scheme, size, lineHeight } of themes) {
  test(`${theme} ${scheme} keeps narrative readable with theme typography`, async ({
    page,
  }) => {
    await seedBrowserSettings(page, {
      "ui.onboardedVersion": 3,
      "ui.locale": "en-US",
      "ui.appearance": theme,
      "ui.scheme": scheme,
    });
    await page.goto("/session");
    const preview = await openAppearance(page);
    const paragraph = preview.locator("p").first();
    const foreground = await page.locator("body").evaluate((element) => {
      return getComputedStyle(element).color;
    });
    await expect(paragraph).toHaveCSS("color", foreground);
    await expect(preview.locator("strong")).toHaveCSS("color", foreground);
    await expect(paragraph).toHaveCSS("font-size", size);
    await expect(paragraph).toHaveCSS("line-height", lineHeight);

    const contrast = await preview.evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      function luminance(color: string) {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const channels = [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return (
          channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
        );
      }
      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(
        getComputedStyle(element.parentElement!).backgroundColor,
      );
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      const swatch =
        "#" +
        [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
      return {
        ratio:
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05),
        swatch,
      };
    });
    expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
    await expect(
      page
        .getByLabel("Body color", { exact: true })
        .and(page.locator('input[type="color"]')),
    ).toHaveValue(contrast.swatch);

    // Legacy Markdown surfaces still carry prose-invert; it must not restore
    // Typography's unrelated gray palette over the selected theme.
    await preview.evaluate((element) => {
      element.classList.remove("ui-narrative");
      element.classList.add("dark:prose-invert");
    });
    await expect(paragraph).toHaveCSS("color", foreground);
    await expect(preview.locator("strong")).toHaveCSS("color", foreground);
  });
}

test("reading preferences preview, persist, switch schemes and reset", async ({
  page,
}) => {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": 3,
    "ui.locale": "en-US",
    "ui.appearance": "paper",
    "ui.scheme": "dark",
  });
  await page.goto("/session");
  let preview = await openAppearance(page);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Body color", exact: true })
    .and(dialog.locator('input[type="text"]'))
    .fill("#f4ead8");
  await dialog
    .getByRole("textbox", { name: "Body size", exact: true })
    .fill("1.25rem");
  await dialog
    .getByRole("slider", { name: "Line height", exact: true })
    .fill("2");
  await dialog
    .getByRole("combobox", { name: "Weight", exact: true })
    .selectOption("500");
  await dialog
    .getByRole("textbox", { name: "Column width", exact: true })
    .fill("32rem");
  await expect(preview.locator("p").first()).toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );
  await expect(preview.locator("p").first()).toHaveCSS("font-size", "20px");
  await expect(preview.locator("p").first()).toHaveCSS("line-height", "40px");
  await expect(preview).toHaveCSS("font-weight", "500");
  await expect(preview).toHaveCSS("max-width", "512px");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const settings = JSON.parse(
          localStorage.getItem("covel:settings") ?? "{}",
        );
        return settings.entries?.["ui.appearanceTokens"]?.shared?.[
          "--story-max-width"
        ];
      }),
    )
    .toBe("32rem");

  await page.reload();
  preview = await openAppearance(page);
  await expect(preview.locator("p").first()).toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );
  await expect(preview.locator("p").first()).toHaveCSS("font-size", "20px");
  await expect(preview.locator("p").first()).toHaveCSS("line-height", "40px");

  await dialog.locator("summary").filter({ hasText: "Theme Library" }).click();
  await dialog.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
  await expect(preview.locator("p").first()).not.toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );
  await expect(preview.locator("p").first()).toHaveCSS("font-size", "20px");
  await dialog
    .getByRole("textbox", { name: "Body color", exact: true })
    .and(dialog.locator('input[type="text"]'))
    .fill("#292018");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const settings = JSON.parse(
          localStorage.getItem("covel:settings") ?? "{}",
        );
        return settings.entries?.["ui.appearanceTokens"]?.light?.[
          "--story-color"
        ];
      }),
    )
    .toBe("#292018");
  await dialog.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(preview.locator("p").first()).toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );

  await dialog
    .getByRole("button", { name: "Reset group", exact: true })
    .click();
  const foreground = await page
    .locator("body")
    .evaluate((element) => getComputedStyle(element).color);
  await expect(preview.locator("p").first()).toHaveCSS("color", foreground);
  await expect(preview.locator("p").first()).toHaveCSS("font-size", "16px");
  await expect(preview.locator("p").first()).toHaveCSS(
    "line-height",
    "28.48px",
  );
});

test("saving a theme preserves story colour inherited from primary text", async ({
  page,
}) => {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": 3,
    "ui.locale": "en-US",
    "ui.appearance": "paper",
    "ui.scheme": "dark",
    "ui.appearanceTokens": {
      shared: {},
      light: { "--color-foreground": "#292018" },
      dark: { "--color-foreground": "#f4ead8" },
    },
  });
  await page.goto("/session");
  const preview = await openAppearance(page);
  const dialog = page.getByRole("dialog");
  await expect(preview.locator("p").first()).toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );
  await dialog
    .getByRole("textbox", { name: "Save as theme package" })
    .fill("Reading theme");
  await dialog.getByRole("button", { name: "Save as", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "reading-theme",
  );
  await expect(preview.locator("p").first()).toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );
  await dialog.locator("summary").filter({ hasText: "Theme Library" }).click();
  await dialog.getByRole("button", { name: "Light", exact: true }).click();
  await expect(preview.locator("p").first()).toHaveCSS(
    "color",
    "rgb(41, 32, 24)",
  );
  await dialog.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(preview.locator("p").first()).toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );
  await page.reload();
  await openAppearance(page);
  await expect(preview.locator("p").first()).toHaveCSS(
    "color",
    "rgb(244, 234, 216)",
  );
});
