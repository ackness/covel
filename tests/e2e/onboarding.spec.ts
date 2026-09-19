import { test, expect, type Page } from "@playwright/test";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  useServerWorlds,
} from "./helpers/player.js";

async function firstVisit(page: Page, entries: Record<string, unknown> = {}) {
  await seedBrowserSettings(page, {
    "ui.locale": "en-US",
    "ui.onboardedVersion": 0,
    ...entries,
  });
  await page.route("**/api/presets", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/api/llm-config", (route) =>
    route.fulfill({
      json: { configured: false, slots: {}, providers: [] },
    }),
  );
  await useServerWorlds(page);
}

async function storedEntries(page: Page) {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem("covel:settings") ?? "{}").entries,
  );
}

test("first visit starts from the landing page, explains preparation and can be reopened after reload", async ({
  page,
}) => {
  await firstVisit(page);
  await page.goto("/");
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
  await page
    .getByRole("link", { name: /Start Playing/i })
    .first()
    .click();
  const guide = page.getByTestId("onboarding-wizard");
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: "Start the guide" }).click();
  await expect(guide.getByRole("status")).toContainText(
    "No text model binding detected",
  );
  await guide.getByRole("button", { name: "Learn how to play" }).click();
  await expect(guide).toContainText("recommended play pack");
  await expect(guide.getByRole("status")).toContainText(
    "complete model setup before starting a game",
  );
  // Hold the real persistence lock so dismissal must wait for the saved flag.
  await page.evaluate(
    () =>
      new Promise<void>((acquired) => {
        const held = new Promise<void>((release) => {
          Object.assign(window, { releaseOnboardingSave: release });
        });
        void navigator.locks.request("covel:settings-persistence", async () => {
          acquired();
          await held;
        });
      }),
  );
  await guide
    .getByRole("button", { name: "Choose a world", exact: true })
    .click();
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute("aria-busy", "true");
  expect((await storedEntries(page))["ui.onboardedVersion"]).toBe(0);
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      releaseOnboardingSave?: () => void;
    };
    fixtureWindow.releaseOnboardingSave?.();
    delete fixtureWindow.releaseOnboardingSave;
  });
  await expect(guide).toHaveCount(0);
  expect((await storedEntries(page))["ui.onboardedVersion"]).toBe(
    ONBOARDING_VERSION,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Choose a world" }),
  ).toBeVisible();
  await expect(guide).toHaveCount(0);
  await page.getByRole("button", { name: "Getting started guide" }).click();
  await expect(
    guide.getByRole("heading", { name: "Welcome to Covel" }),
  ).toBeVisible();
  await guide.getByRole("button", { name: "Browse worlds first" }).click();
  await page
    .getByRole("button", { name: "Enter", exact: true })
    .first()
    .click();
  const mismatch = page.getByRole("button", { name: /Continue in/ });
  if (await mismatch.isVisible()) await mismatch.click();
  await expect(
    page.getByRole("button", { name: "Start Game", exact: true }),
  ).toBeVisible();
});

test("canonical provider configuration returns to the guide, keeps assignments, and tests only on request", async ({
  page,
}) => {
  await firstVisit(page);
  const pings: unknown[] = [];
  await page.route("**/api/ai/ping", async (route) => {
    pings.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        ok: false,
        latencyMs: 0,
        error: "Synthetic connection unavailable",
      },
    });
  });
  await page.goto("/session");
  const guide = page.getByTestId("onboarding-wizard");
  await guide.getByRole("button", { name: "Start the guide" }).click();
  await guide
    .getByRole("button", { name: "Configure Providers & Models" })
    .click();
  await expect(guide).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add provider", exact: true })
    .first()
    .click();
  const add = page.getByRole("dialog", { name: "Add provider", exact: true });
  await add.locator("input").nth(0).fill("onboarding-fixture");
  await add.locator("input").nth(1).fill("http://127.0.0.1:9/v1");
  await add.getByRole("textbox", { name: "Model IDs" }).fill("fixture-text");
  await add.getByRole("button", { name: "Add provider", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(
    settings.getByText("fixture-text", { exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    guide.getByRole("heading", { name: "Connect a model for your story" }),
  ).toBeVisible();
  await expect(guide.getByRole("status")).toHaveText(
    "Text model bindings detected",
  );
  const before = await storedEntries(page);
  expect(before["llm.providers"][0].models[0].modelId).toBe("fixture-text");
  expect(before["llm.slotConfig"].story.modelRef).toBe(
    before["llm.slotConfig"].plugin.modelRef,
  );
  expect(pings).toEqual([]);
  await guide
    .locator("summary")
    .filter({ hasText: "Review and test existing models" })
    .click();
  await guide
    .getByRole("button", { name: "Ping", exact: true })
    .first()
    .click();
  await guide.getByRole("button", { name: "Show details" }).click();
  await expect(guide).toContainText("Synthetic connection unavailable");
  expect(pings).toHaveLength(1);
  await guide.getByRole("button", { name: "Check Model Roles" }).click();
  await expect(
    page.getByRole("button", { name: "Model Roles", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await guide.getByRole("button", { name: "Learn how to play" }).click();
  await guide
    .getByRole("button", { name: "Choose a world", exact: true })
    .click();
  const after = await storedEntries(page);
  expect(after["llm.providers"]).toEqual(before["llm.providers"]);
  expect(after["llm.slotConfig"]).toEqual(before["llm.slotConfig"]);
});

test("an upgrade can be skipped without rewriting existing model roles", async ({
  page,
}) => {
  const bindings = {
    story: { modelRef: "fixture-story" },
    plugin: { modelRef: "fixture-tracker" },
  };
  const providers = [
    {
      id: "fixture",
      name: "Fixture",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [
        { ref: "fixture-story", modelId: "story-model" },
        { ref: "fixture-tracker", modelId: "tracker-model" },
      ],
    },
  ];
  await firstVisit(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION - 1,
    "llm.providers": providers,
    "llm.slotConfig": bindings,
  });
  await page.goto("/session");
  const guide = page.getByTestId("onboarding-wizard");
  await guide.getByRole("button", { name: "Start the guide" }).click();
  await guide
    .locator("summary")
    .filter({ hasText: "Review and test existing models" })
    .click();
  await expect(guide).toContainText("story-model");
  await expect(guide).toContainText("tracker-model");
  await guide.getByRole("button", { name: "Close", exact: true }).click();
  await expect(guide).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Choose a world" }),
  ).toBeVisible();
  await expect(guide).toHaveCount(0);
  const entries = await storedEntries(page);
  expect(entries["llm.slotConfig"]).toEqual(bindings);
  expect(entries["llm.providers"]).toEqual(providers);
});

test("mobile guide keeps actions reachable, traps focus, switches language, and restores settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await firstVisit(page);
  await page.goto("/session");
  const guide = page.getByTestId("onboarding-wizard");
  await guide.getByRole("combobox", { name: "Language" }).selectOption("zh-CN");
  await expect(
    guide.getByRole("heading", { name: "欢迎来到 Covel" }),
  ).toBeVisible();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    expect(
      await guide.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await guide.getByRole("button", { name: "开始引导" }).click();
  await expect(
    guide.getByRole("button", { name: "配置服务商与模型" }),
  ).toBeInViewport({ ratio: 1 });
  await guide.getByRole("button", { name: "配置服务商与模型" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings.getByRole("combobox", { name: "设置" })).toHaveValue(
    "llm.providers",
  );
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await guide.getByRole("button", { name: "了解如何游玩" }).click();
  const finish = guide.getByRole("button", { name: "去选择世界" });
  const bounds = await finish.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(664);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.keyboard.press("Escape");
  await expect(guide).toHaveCount(0);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(guide).toHaveCount(0);
});
