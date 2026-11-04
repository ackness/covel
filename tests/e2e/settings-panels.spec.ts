import { expect, test } from "@playwright/test";
import type { SessionPlugin } from "@covel/shared";
import {
  closeStudioConfiguration,
  ONBOARDING_VERSION,
  openStudioConfiguration,
  seedBrowserSettings,
  openAppSettings,
} from "./helpers/player.js";
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
    "llm.slotConfig": {
      "custom-analysis": {
        modelRef: "fixture-model",
      },
    },
    "llm.paramOverrides": { default: { temperature: 0.3 } },
  });
  await page.goto("/session");
  const savedEntries = () =>
    page.evaluate(
      () => JSON.parse(localStorage.getItem("covel:settings") ?? "{}").entries,
    );
  await openAppSettings(page);
  const settings = page.getByRole("dialog");
  await settings
    .getByRole("button", { name: "Generation", exact: true })
    .click();
  await settings
    .getByRole("combobox", { name: "Select AI role" })
    .selectOption("default");
  await expect(
    settings.getByRole("spinbutton", { name: "Temperature" }),
  ).toHaveValue("0.3");
  await settings.getByRole("spinbutton", { name: "Temperature" }).fill("0.2");
  // Number drafts commit on blur; selectOption changes the select without
  // moving focus away from the input as a player would.
  await settings.getByRole("spinbutton", { name: "Temperature" }).press("Tab");
  await expect
    .poll(
      async () =>
        (await savedEntries())?.["llm.paramOverrides"]?.default?.temperature,
    )
    .toBe(0.2);
  await settings
    .getByRole("combobox", { name: "Select AI role" })
    .selectOption("custom-analysis");
  await expect(
    settings.getByText("fixture-text", { exact: true }),
  ).toBeVisible();
  await settings.getByRole("spinbutton", { name: "Temperature" }).fill("0.4");
  await settings.getByRole("spinbutton", { name: "Temperature" }).press("Tab");
  // A draft value is visible before its queued persistence completes.
  await expect
    .poll(
      async () =>
        (await savedEntries())?.["llm.paramOverrides"]?.["custom-analysis"]
          ?.temperature,
    )
    .toBe(0.4);
  await settings.getByRole("button", { name: "AI roles", exact: true }).click();
  await expect(
    settings.getByText("custom-analysis", { exact: true }).first(),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Preferences", exact: true })
    .click();
  await expect(
    settings.getByText("Onboarding version", { exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Import, backup & reset", exact: true })
    .click();
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
  await expect(settings.getByText("Imported", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  const entries = await savedEntries();
  expect(entries["llm.paramOverrides"]["custom-analysis"].temperature).toBe(
    0.4,
  );
  expect(entries["ui.chatMessageWindow"]).not.toBe("old-invalid");
  expect(entries["llm.paramOverrides"].default.temperature).toBe(0.2);
  expect(entries["llm.slotConfig"]["custom-analysis"].modelRef).toBe(
    "fixture-model",
  );
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
      kind: "plugin",
      active: true,
      locked: false,
      runtimeCount: 3,
      capabilities: [],
      tags: [],
      tools: [],
      userSettings: [],
      languages: { text: ["en"], instructions: ["en"] },
      runtimes: [
        {
          id: "panel-fixture/function",
          runtimeType: "function",
          stage: "pre-turn",
          trigger: { type: "auto" },
          execution: "sync",
          turnCompletion: { mode: "await" },
          outputKind: "system",
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
          outputKind: "system" as const,
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
    let releaseHealth = () => {};
    try {
      await page.goto(`/session?sid=${fixture.id}`);
      // Notice cards float above the header on a narrow screen and would
      // cover the menu: dismiss them first.
      const dismiss = page.getByRole("button", { name: "先收起", exact: true });
      await dismiss.first().waitFor();
      while ((await dismiss.count()) > 0) await dismiss.first().click();
      // "This game's settings" opens from the session menu.
      await openStudioConfiguration(page);
      const pluginName = page
        .getByRole("button", { name: "Current plugin fixture", exact: true })
        .getByText("Current plugin fixture", { exact: true });
      await expect(pluginName).toBeVisible();
      expect((await pluginName.boundingBox())!.width).toBeGreaterThan(40);
      // The model of each step is read-only text with a link to Settings.
      await pluginName.click();
      await expect(
        page.getByText("panel-fixture/plugin", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("combobox", { name: /模型/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "去设置" })).toBeVisible();
      await closeStudioConfiguration(page);
      if (width === 390) {
        const health = await (await page.request.get("/api/health")).json();
        const healthReady = Promise.withResolvers<void>();
        releaseHealth = () => healthReady.resolve();
        await page.route("**/api/health", async (route) => {
          await healthReady.promise;
          await route.fulfill({
            json: {
              ...health,
              storage: {
                ...health.storage,
                data: { ...health.storage?.data, frontendMode: "remote" },
              },
            },
          });
        });
        await page.getByRole("button", { name: "侧栏" }).click();
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
        // A late storage badge reduces the rail height after selection.
        releaseHealth();
        await expect(
          page.getByRole("dialog").getByText("内存", { exact: true }),
        ).toBeVisible();
        await expect(lastTab).toBeInViewport({ ratio: 0.98 });
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "关闭", exact: true })
          .click();
      }
      await openStudioConfiguration(page);
      await page
        .getByRole("switch", { name: /Current plugin fixture/ })
        .click();
      await closeStudioConfiguration(page);
      if (width === 390)
        await page.getByRole("button", { name: "侧栏" }).click();
      await expect(
        page.getByRole("tab", { name: "Fixture panel 15", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("tab", { name: "世界", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      expect(fixture.actions).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      releaseHealth();
      await fixture.dispose();
    }
  });
}
