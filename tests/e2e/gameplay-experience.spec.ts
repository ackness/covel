import { expect, test, type Page } from "@playwright/test";
import {
  seedAppSettings,
  selectWorldByText,
  useServerWorlds,
} from "./helpers/player.js";

test.use({ viewport: { width: 1512, height: 955 } });

async function restoreReadingFixture(page: Page): Promise<string> {
  await seedAppSettings(page);
  await useServerWorlds(page);
  await page.goto("/session");
  await selectWorldByText(page, /雾港|Mistport/i);
  await page
    .getByRole("button", { name: /^(开始游戏|Start game)$/i })
    .first()
    .click();
  await expect(page).toHaveURL(/sid=/);
  const id = new URL(page.url()).searchParams.get("sid")!;
  const sessionPath = `**/api/sessions/${id}`;
  await page.route(sessionPath, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), phase: "playing" },
    });
  });
  await page.route(`${sessionPath}/view`, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({
      response,
      json: {
        ...snapshot,
        session: {
          ...snapshot.session,
          phase: "playing",
          completedPlayerTurns: 1,
        },
        messages: [
          {
            id: "reading-story",
            role: "assistant",
            kind: "story",
            turnId: "reading-turn",
            content:
              "The harbor lamps guide you toward the archive. The evidence is intact.\n\nYou place the notebook on the table and wait for the archivist.",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        executionSteps: [
          {
            type: "runtime.completed",
            turnId: "reading-turn",
            timestamp: "2026-01-01T00:00:01Z",
            payload: {
              runtimeId: "narrator",
              pluginId: "narrator",
              status: "success",
            },
          },
          {
            type: "runtime.failed",
            turnId: "reading-turn",
            timestamp: "2026-01-01T00:00:02Z",
            payload: {
              runtimeId: "world-ir",
              pluginId: "world-ir",
              error: "Extraction timed out",
            },
          },
        ],
      },
    });
  });
  await page.reload();
  await expect(page.locator(".ui-narrative p").first()).toBeVisible();
  return id;
}

test("story remains legible in both themes and failed updates stay visible", async ({
  page,
}) => {
  const id = await restoreReadingFixture(page);
  try {
    const seenModes = new Set<boolean>();
    for (let index = 0; index < 2; index += 1) {
      const reading = await page
        .locator(".ui-narrative")
        .first()
        .evaluate((element) => {
          const paragraphs = element.querySelectorAll("p");
          const style = getComputedStyle(paragraphs[0]);
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const luminance = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const rgb = [...context.getImageData(0, 0, 1, 1).data]
              .slice(0, 3)
              .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4;
              });
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          };
          const fg = luminance(style.color);
          const bg = luminance(getComputedStyle(document.body).backgroundColor);
          return {
            dark: document.documentElement.classList.contains("dark"),
            contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
            fontSize: parseFloat(style.fontSize),
            lineHeight: parseFloat(style.lineHeight),
            paragraphGap: parseFloat(getComputedStyle(paragraphs[1]).marginTop),
          };
        });
      seenModes.add(reading.dark);
      expect(reading.contrast).toBeGreaterThanOrEqual(4.5);
      expect(reading.fontSize).toBeGreaterThanOrEqual(16);
      expect(reading.lineHeight).toBeGreaterThanOrEqual(
        reading.fontSize * 1.65,
      );
      expect(reading.paragraphGap).toBeGreaterThanOrEqual(16);
      if (index === 0) {
        await page
          .getByRole("button", { name: /切换主题|Toggle theme/i })
          .click();
        await expect
          .poll(() =>
            page
              .locator("html")
              .evaluate((element) => element.classList.contains("dark")),
          )
          .toBe(!reading.dark);
      }
    }
    expect(seenModes.size).toBe(2);
    await expect(
      page.getByText(/部分更新未完成|Some updates failed/),
    ).toBeVisible();
    const summary = page.getByRole("button", {
      name: /执行.*失败|Execution.*Failed/i,
    });
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("alert").filter({ hasText: /世界|World/ }),
    ).toBeVisible();
    await page.screenshot({ path: "debugs/e2e-logs/gameplay-reading.png" });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    expect(
      (await page.request.delete(`/api/sessions/${id}`)).ok(),
    ).toBeTruthy();
  }
});

test("settings and context rails survive desktop-mobile-desktop transitions", async ({
  page,
}) => {
  const id = await restoreReadingFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page
      .getByTestId("center-panel")
      .getByRole("button", { name: /^设置$|^Settings$/ })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    for (const width of [900, 390, 1512, 390, 900, 1512]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 955 });
      await expect(page.getByRole("dialog")).toBeVisible();
    }
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^关闭$|^Close$/ })
      .click();
    await expect(page.getByTestId("game-composer-input")).toBeVisible();
    await page
      .getByRole("button", { name: /切换状态与世界上下文|Toggle context/i })
      .click();
    await page
      .getByRole("button", { name: /切换状态与世界上下文|Toggle context/i })
      .click();
    await page
      .getByTestId("game-composer-input")
      .fill("Keep the evidence intact");
    await expect(page.getByTestId("game-composer-input")).toHaveValue(
      "Keep the evidence intact",
    );
    await expect(
      page.getByText(/Panel constraints not found|渲染此视图时发生错误/),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: "debugs/e2e-logs/gameplay-responsive.png" });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    expect(
      (await page.request.delete(`/api/sessions/${id}`)).ok(),
    ).toBeTruthy();
  }
});
