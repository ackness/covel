import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createRecoveryFixture } from "./execution-recovery-fixtures.js";

// Exercise the installed example HTML through the real host bridge. HTTP
// installation, authorization and persistence are covered by the server suite.
test("notes example discovers arbitrary providers and preserves failed drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await createRecoveryFixture(page, "completed");
  const pluginId = "notes-workbench";
  const html = readFileSync(
    new URL(
      "../../examples/composable-notes/plugins/notes-workbench/ui/workbench.html",
      import.meta.url,
    ),
    "utf8",
  );
  const mask = `**/api/sessions/${fixture.id}`;
  let available = true;
  const requests: Array<{
    runtimeId: string;
    payload?: { text?: string; providerPluginId?: string };
  }> = [];
  const directory = await (
    await page.request.get(`/api/sessions/${fixture.id}/plugins`)
  ).json();
  await page.route(`${mask}/plugins`, (route) =>
    route.fulfill({
      json: {
        ...directory,
        items: [
          ...directory.items,
          {
            id: pluginId,
            displayName: "Notes Workbench",
            description: "Example",
            pluginType: "plugin",
            active: true,
            locked: false,
            source: "community",
            status: "registered",
            runtimeCount: 2,
            runtimes: [],
            tools: [],
            userSettings: [],
            capabilities: [],
            tags: [],
          },
        ],
      },
    }),
  );
  await page.route("**/api/ui-specs?**", (route) =>
    route.fulfill({
      json: {
        right: [
          {
            pluginId,
            specs: [
              {
                id: pluginId,
                label: "Notes Workbench",
                alwaysRender: true,
                dataSource: { namespace: "notes" },
                webview: { html, height: 580 },
              },
            ],
          },
        ],
        left: [],
        message: [],
      },
    }),
  );
  const unsafeText = '<img src=x onerror="alert(1)">';
  await page.route(`${mask}/plugin-data/${pluginId}{,/**}`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            namespace: "notes",
            key: "existing",
            value: {
              id: "existing",
              text: unsafeText,
              originalText: unsafeText,
              providerPluginId: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
          },
        ],
      },
    }),
  );
  await page.route(`${mask}/plugin-rpc`, async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    expect(request.pluginId).toBe(pluginId);
    if (request.runtimeId === `${pluginId}/providers`) {
      await route.fulfill({
        json: {
          status: "ok",
          runtimeResults: [
            {
              runtimeId: request.runtimeId,
              pluginId,
              status: "success",
              durationMs: 1,
              output: {
                providers: available
                  ? [
                      {
                        pluginId: "independent-formatter",
                        name: "format-note",
                        description: "Independent formatter",
                      },
                    ]
                  : [],
              },
            },
          ],
        },
      });
    } else {
      await route.fulfill({
        json: {
          status: "ok",
          runtimeResults: [
            {
              runtimeId: request.runtimeId,
              pluginId,
              status: available ? "success" : "failed",
              durationMs: 1,
              output: available ? { note: { id: "new-note" } } : null,
            },
          ],
        },
      });
    }
  });
  try {
    await page.goto(`/session?sid=${fixture.id}`);
    await page.getByRole("button", { name: "切换状态与世界上下文" }).click();
    await page
      .getByRole("tab", { name: "Notes Workbench", exact: true })
      .click();
    const frame = page.frameLocator('iframe[title="Notes Workbench"]');
    await expect(
      frame.getByRole("heading", { name: "记录工作台" }),
    ).toBeVisible();
    await expect(frame.locator("#notes")).toContainText(unsafeText);
    expect(await frame.locator("#notes img").count()).toBe(0);
    expect(requests).toHaveLength(0);
    await frame.getByRole("button", { name: "刷新处理方式" }).click();
    await expect(frame.locator("#processor option")).toHaveCount(2);
    await frame.getByLabel("处理方式").selectOption("independent-formatter");
    const draft = "Keep this draft";
    await frame.getByLabel("记录内容").fill(draft);
    available = false;
    await frame.getByRole("button", { name: "保存记录" }).click();
    await expect(frame.getByRole("status")).toContainText("草稿已保留");
    await expect(frame.getByLabel("记录内容")).toHaveValue(draft);
    expect(requests.at(-1)).toMatchObject({
      runtimeId: `${pluginId}/save`,
      payload: { text: draft, providerPluginId: "independent-formatter" },
    });
    await frame.getByRole("button", { name: "刷新处理方式" }).click();
    await expect(frame.getByRole("status")).toContainText("尚无可用处理方式");
    await expect(frame.getByLabel("处理方式")).toHaveValue(
      "independent-formatter",
    );
    await expect(
      frame.getByRole("button", { name: "保存记录" }),
    ).toBeDisabled();
    await frame.getByLabel("处理方式").selectOption("");
    available = true;
    await frame.getByRole("button", { name: "保存记录" }).click();
    await expect(frame.getByRole("status")).toHaveText("记录已保存。");
    await expect(frame.getByLabel("记录内容")).toHaveValue("");
    expect(requests.at(-1)?.payload).toEqual({ text: draft });
    expect(
      await frame
        .locator("body")
        .evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  } finally {
    await fixture.dispose();
  }
});
