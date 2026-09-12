import { expect, test } from "@playwright/test";
import type { SessionPlugin } from "@covel/shared";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";
import { createRecoveryFixture } from "./execution-recovery-fixtures.js";

test("saved custom roles remain editable in generation, assignment and import panes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
    "llm.providers": [
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ ref: "fixture-model", modelId: "fixture-text" }],
      },
    ],
    "llm.slotConfig": { "custom-analysis": { modelRef: "fixture-model" } },
  });
  await page.goto("/session");
  await page
    .getByRole("button", { name: /Configure Providers & Models/ })
    .click();
  const settings = page.getByRole("dialog");
  await settings
    .getByRole("button", { name: "Generation", exact: true })
    .click();
  await settings
    .getByRole("combobox", { name: "Select Slot" })
    .selectOption("custom-analysis");
  await expect(
    settings.getByText("fixture-text", { exact: true }),
  ).toBeVisible();
  await settings.getByRole("spinbutton", { name: "Temperature" }).fill("0.4");
  await settings
    .getByRole("button", { name: "Model Roles", exact: true })
    .click();
  await expect(
    settings.getByText("custom-analysis", { exact: true }).first(),
  ).toBeVisible();
  await settings.getByRole("button", { name: "General", exact: true }).click();
  await expect(
    settings.getByText("Onboarding version", { exact: true }),
  ).toHaveCount(0);
  await settings.getByRole("button", { name: "Data", exact: true }).click();
  await settings.getByLabel("Choose file...").setInputFiles({
    name: "settings-compatibility.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          "ui.chatMessageWindow": "old-invalid",
          "ui.locale": "en-US",
        },
      }),
    ),
  });
  await expect(
    settings.getByRole("checkbox", { name: "ui.chatMessageWindow" }),
  ).toBeDisabled();
  await settings
    .getByRole("button", { name: "Apply (1)", exact: true })
    .click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  const entries = await page.evaluate(
    () => JSON.parse(localStorage.getItem("covel:settings") ?? "{}").entries,
  );
  expect(entries["llm.paramOverrides"]["custom-analysis"].temperature).toBe(
    0.4,
  );
  expect(entries["ui.chatMessageWindow"]).not.toBe("old-invalid");
});

for (const width of [1512, 390]) {
  test(`session runtime settings and long state panel navigation adapt at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 750 : 900 });
    const fixture = await createRecoveryFixture(page, "completed");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const plugin: SessionPlugin = {
      id: "panel-fixture",
      displayName: "Current plugin fixture",
      description: "Current session metadata",
      status: "registered",
      source: "builtin",
      pluginType: "plugin",
      active: true,
      locked: false,
      runtimeCount: 3,
      capabilities: [],
      tags: [],
      tools: [],
      userSettings: [],
      runtimes: [
        {
          id: "panel-fixture/function",
          runtimeType: "function",
          stage: "pre-turn",
          trigger: { type: "auto" },
          execution: "sync",
          turnCompletion: { mode: "await" },
          outputKind: "plugin",
          capabilities: [],
          tags: [],
        },
        ...["story", "plugin"].map((model) => ({
          id: `panel-fixture/${model}`,
          runtimeType: "agent" as const,
          model,
          stage: "post-turn" as const,
          trigger: { type: "auto" as const },
          execution: "sync" as const,
          turnCompletion: { mode: "await" as const },
          outputKind: "plugin" as const,
          capabilities: [],
          tags: [],
        })),
      ],
    };
    let active = true;
    const assignments: Array<Record<string, string>> = [];
    const path = `**/api/sessions/${fixture.id}`;
    const record = await (
      await page.request.get(`/api/sessions/${fixture.id}`)
    ).json();
    await page.route(path, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const update = route.request().postDataJSON();
      assignments.push(update.runtimeModelOverrides);
      await route.fulfill({ json: { ...record, phase: "playing", ...update } });
    });
    await page.route(`${path}/plugins`, (route) =>
      route.fulfill({ json: { items: [{ ...plugin, active }], commands: [] } }),
    );
    await page.route(`${path}/plugins/panel-fixture`, async (route) => {
      active = route.request().method() !== "DELETE";
      await route.fulfill({
        json: { ok: true, activePlugins: active ? [plugin.id] : [] },
      });
    });
    await page.route("**/api/ui-specs?**", (route) =>
      route.fulfill({
        json: {
          right: active
            ? [
                {
                  pluginId: plugin.id,
                  specs: Array.from({ length: 16 }, (_, index) => ({
                    id: `panel-${index}`,
                    label: `Fixture panel ${index}`,
                    icon: "book-open",
                    emptyState: { message: `Current panel content ${index}` },
                    view: {},
                  })),
                },
              ]
            : [],
          message: [],
          left: [],
        },
      }),
    );
    await page.route(`${path}/plugin-data/panel-fixture**`, (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    try {
      await page.goto(`/session?sid=${fixture.id}`);
      await expect(
        page.getByRole("button", { name: "切换故事侧栏" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "切换故事侧栏" }).click();
      await page
        .getByRole("checkbox", { name: "自定义插件与高级设置" })
        .check();
      const pluginName = page
        .getByRole("button", { name: "Current plugin fixture", exact: true })
        .getByText("Current plugin fixture", { exact: true });
      await expect(pluginName).toBeVisible();
      expect((await pluginName.boundingBox())!.width).toBeGreaterThan(40);
      const model = page.getByRole("combobox", {
        name: "模型 · panel-fixture/plugin",
      });
      await expect(model).toBeVisible();
      const options = await model
        .locator("option")
        .evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLOptionElement).value),
        );
      expect(options).toContain("story");
      expect(options).not.toContain("image");
      await model.selectOption("story");
      await expect
        .poll(() => assignments.at(-1)?.["panel-fixture/plugin"])
        .toBe("story");
      if (width === 390) {
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "关闭", exact: true })
          .click();
        await page
          .getByRole("button", { name: "切换状态与世界上下文" })
          .click();
      }
      const lastTab = page.getByRole("tab", {
        name: "Fixture panel 15",
        exact: true,
      });
      await lastTab.click();
      await expect(
        page.getByText("Current panel content 15", { exact: true }),
      ).toBeVisible();
      await expect(lastTab).toBeInViewport({ ratio: 0.98 });
      if (width === 390) {
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "关闭", exact: true })
          .click();
        await page.getByRole("button", { name: "切换故事侧栏" }).click();
      }
      await page
        .getByRole("switch", { name: /Current plugin fixture/ })
        .click();
      if (width === 390) {
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "关闭", exact: true })
          .click();
        await page
          .getByRole("button", { name: "切换状态与世界上下文" })
          .click();
      }
      await expect(
        page.getByRole("tab", { name: "Fixture panel 15", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("tab", { name: "世界", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      expect(fixture.actions).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
}
