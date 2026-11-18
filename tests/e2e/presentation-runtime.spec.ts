import { expect, test, type Page } from "@playwright/test";
import { startPresentationBrowserHost } from "../../apps/server/tests/helpers/presentation-browser.js";
import {
  composer,
  composerInput,
  ONBOARDING_VERSION,
  seedBrowserSettings,
  waitForTurnIdle,
} from "./helpers/player.js";

type PresentationHost = Awaited<
  ReturnType<typeof startPresentationBrowserHost>
>;

async function openPresentationSession(
  page: Page,
  host: PresentationHost,
  appearance = "panel",
) {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "zh-CN",
    "ui.appearance": appearance,
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config/info")
      return route.fulfill({ json: { isDesktop: false } });
    if (url.pathname === "/api/health") {
      const health = await fetch(`${host.baseUrl}/api/health`).then(
        (response) => response.json(),
      );
      return route.fulfill({
        json: {
          ...health,
          storage: {
            ...health.storage,
            data: { ...health.storage?.data, frontendMode: "remote" },
          },
        },
      });
    }
    await route.continue({
      url: `${host.baseUrl}${url.pathname}${url.search}`,
    });
  });
  const hydration = ["view", "plugins"].map((resource) =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/sessions/${host.sessionId}/${resource}` && response.ok(),
    ),
  );
  await page.goto(`/session?sid=${host.sessionId}`);
  await Promise.all(hydration);
  await expect(composerInput(page)).toBeVisible();
  await expect(page.getByTestId("notice-no-story-plugin")).toBeHidden();
}

async function showStage(page: Page) {
  await page.getByRole("button", { name: "舞台", exact: true }).click();
  await expect(page.getByTestId("stage-view")).toBeVisible();
  await expect(page.getByTestId("stage-choices")).toBeVisible();
}

async function expectPresentation(page: Page) {
  const backdrop = page.getByTestId("stage-backdrop").locator("img").last();
  await expect(backdrop).toBeVisible();
  await expect
    .poll(() =>
      backdrop.evaluate(
        (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(page.getByTestId("stage-hud")).toContainText("Library");
  await expect(page.getByTestId("stage-hud")).toContainText("世界背景");
  await expect(
    page.getByTestId("stage-sprites").getByLabel("Mira", { exact: true }),
  ).toBeVisible();
  // The music switch lives in the session menu, with the playing track.
  await page.getByRole("button", { name: "菜单", exact: true }).click();
  const music = page.getByRole("switch", { name: "背景音乐（所有游戏）" });
  await expect(music).toBeChecked();
  await expect(page.getByText("Library tension")).toBeVisible();
  await page.keyboard.press("Escape");
}

async function expectDisplay(page: Page, title: string, source: string) {
  const panel = page.getByTestId("stage-plugin-panels");
  await expect(panel.getByText(title, { exact: true })).toBeVisible();
  await expect(panel.getByText(source, { exact: true })).toBeVisible();
}

test("reading and stage widths resize independently and fit a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1720, height: 900 });
  const host = await startPresentationBrowserHost("updated");
  try {
    await openPresentationSession(page, host, "stage");
    const reading = page.getByRole("separator", { name: "调整剧情栏宽度" });
    const stage = page.getByRole("separator", { name: "调整舞台对白宽度" });
    const readPanel = page.locator("#session-reading-panel");
    const stagePanel = page.locator("#stage-width-panel");
    const stageView = page.getByTestId("stage-view");
    host.release();
    await composerInput(page).fill("Enter the library");
    await composerInput(page).press("Enter");
    await waitForTurnIdle(page);
    const story = readPanel.getByText("Public library story 1.", {
      exact: true,
    });
    await expect(story).toBeVisible();
    await expect(reading).toHaveAttribute("aria-valuenow", "608");
    const storyWidth = (await story.boundingBox())!.width;
    const inputWidth = (await composerInput(page).boundingBox())!.width;
    const handle = (await reading.boundingBox())!;
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.width / 2 - 120,
      handle.y + handle.height / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect(reading).toHaveAttribute("aria-valuenow", "728");
    await expect
      .poll(async () => (await readPanel.boundingBox())?.width)
      .toBe(728);
    await expect
      .poll(async () => (await story.boundingBox())!.width)
      .toBeGreaterThan(storyWidth + 105);
    await expect
      .poll(async () => (await composerInput(page).boundingBox())!.width)
      .toBeGreaterThan(inputWidth + 105);

    await showStage(page);
    await expect(stage).toHaveAttribute("aria-valuenow", "768");
    await expect
      .poll(async () => (await stagePanel.boundingBox())?.width)
      .toBe(768);
    const stageHandle = (await stage.boundingBox())!;
    await page.mouse.move(
      stageHandle.x + stageHandle.width / 2,
      stageHandle.y + stageHandle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      stageHandle.x + stageHandle.width / 2 + 40,
      stageHandle.y + stageHandle.height / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect(stage).toHaveAttribute("aria-valuenow", "848");
    await expect
      .poll(async () => (await stagePanel.boundingBox())?.width)
      .toBe(848);
    const panelBounds = (await stagePanel.boundingBox())!;
    const viewBounds = (await stageView.boundingBox())!;
    expect(panelBounds.x + panelBounds.width / 2).toBeCloseTo(
      viewBounds.x + viewBounds.width / 2,
      0,
    );
    await stage.press("ArrowRight");
    await expect(stage).toHaveAttribute("aria-valuenow", "880");
    await expect
      .poll(async () => (await stagePanel.boundingBox())?.width)
      .toBe(880);
    await stage.press("End");
    await expect
      .poll(async () => +(await stage.getAttribute("aria-valuenow"))!)
      .toBe(+(await stage.getAttribute("aria-valuemax"))!);
    await stage.press("Enter");
    await expect(stage).toHaveAttribute("aria-valuenow", "768");
    await stage.press("ArrowRight");
    await page.getByRole("button", { name: "履历", exact: true }).click();
    const history = page.getByRole("dialog", { name: "对话履历" });
    await expect(history).toBeVisible();
    expect((await history.boundingBox())?.width).toBeGreaterThan(800);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(stage).toBeHidden();
    await expect(page.getByTestId("stage-decision-input")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await page.getByTestId("stage-choices").boundingBox())?.width,
      )
      .toBeGreaterThan(340);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(390);
    await page.setViewportSize({ width: 1720, height: 900 });
    await expect(stage).toHaveAttribute("aria-valuenow", "800");
    await page.reload();
    await expect(reading).toHaveAttribute("aria-valuenow", "728");
    await showStage(page);
    await expect(stage).toHaveAttribute("aria-valuenow", "800");

    await page.setViewportSize({ width: 750, height: 900 });
    await expect(stage).toBeVisible();
    await expect
      .poll(async () => Number(await stage.getAttribute("aria-valuemax")))
      .toBeLessThan(768);
    await stage.press("Enter");
    await page.setViewportSize({ width: 1720, height: 900 });
    await expect(stage).toHaveAttribute("aria-valuenow", "768");

    await page.setViewportSize({ width: 1024, height: 320 });
    await page.getByRole("button", { name: "菜单", exact: true }).click();
    const menu = page.getByRole("group", { name: "菜单", exact: true });
    await expect(menu).toBeVisible();
    await expect
      .poll(() =>
        menu.evaluate((element) => {
          const { bottom, left, top, width, height } =
            element.getBoundingClientRect();
          return (
            bottom <= window.innerHeight &&
            element.contains(
              document.elementFromPoint(left + width / 2, top + height / 2),
            )
          );
        }),
      )
      .toBe(true);
    await menu.getByRole("button", { name: "设置…", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "设置", exact: true }),
    ).toBeVisible();
  } finally {
    host.release();
    await page.goto("about:blank");
    await page.unrouteAll({ behavior: "wait" });
    await host.close();
  }
});

test("story and both selectors remain usable while generated display waits and becomes superseded", async ({
  page,
}) => {
  const host = await startPresentationBrowserHost();
  try {
    await openPresentationSession(page, host);
    await composerInput(page).fill("Enter the library");
    await composerInput(page).press("Enter");
    await waitForTurnIdle(page);
    await expect(page.locator(".ui-narrative")).toContainText([
      "Public library story 1.",
    ]);
    await expect.poll(() => host.mediaCalls.length).toBe(1);
    await showStage(page);
    await expectPresentation(page);
    await expect(page.getByTestId("stage-plugin-panels")).toContainText(
      "No generated display",
    );
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await composerInput(page).fill("Read the next shelf");
    await composerInput(page).press("Enter");
    await waitForTurnIdle(page);
    await expect(page.locator(".ui-narrative")).toContainText([
      "Public library story 1.",
      "Public library story 2.",
    ]);
    const override = await fetch(
      `${host.baseUrl}/api/sessions/${host.sessionId}/plugin-data/presentation-probe/display/current`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: {
            title: "Explicit newer display",
            source: "Source: player override",
          },
        }),
      },
    );
    expect(override.ok, await override.text()).toBe(true);
    await page.reload();
    await showStage(page);
    await expectDisplay(
      page,
      "Explicit newer display",
      "Source: player override",
    );
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    host.release();
    await expect
      .poll(
        async () =>
          (await host.jobs()).filter((job) => job.status === "succeeded")
            .length,
      )
      .toBe(2);
    expect(
      (await host.store.listTraceEvents(host.sessionId)).filter(
        (trace) =>
          trace.type === "presentation.completed" &&
          (trace.payload as { reason?: string }).reason === "superseded",
      ),
    ).toHaveLength(2);
    for (const job of await host.jobs()) {
      expect(
        (await host.store.listTraceEvents(host.sessionId)).filter(
          (trace) =>
            trace.type === "presentation.completed" &&
            (trace.payload as { jobId?: string }).jobId === job.jobId,
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            runtimeId: job.runtimeId,
            sourceTurnId: job.origin.sourceTurnId,
            sourceExecutionId: job.origin.sourceExecutionId,
            status: "no-op",
            reason: "superseded",
          }),
        }),
      ]);
    }
    await showStage(page);
    await expectPresentation(page);
    await expectDisplay(
      page,
      "Explicit newer display",
      "Source: player override",
    );
    await expect(page.getByTestId("stage-plugin-panels")).not.toContainText(
      "Generated display",
    );
    // Stage treats a story already shown in another view as read and
    // opens the decision panel instead of replaying it.
    await expect(page.getByTestId("stage-choices")).toBeVisible();
    await page.reload();
    // The view mode is not kept across a reload; reopen the stage.
    await page.getByRole("button", { name: "舞台", exact: true }).click();
    await expect(page.getByTestId("stage-choices")).toBeVisible();
    await expectPresentation(page);
    await expectDisplay(
      page,
      "Explicit newer display",
      "Source: player override",
    );
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await expect(composer(page)).toHaveAttribute("data-executing", "false");
    await expect(composerInput(page)).toBeEnabled();
    await expect(page.locator(".ui-narrative")).toContainText([
      "Public library story 1.",
      "Public library story 2.",
    ]);
    expect(
      await host.store.queryTurnResults(host.sessionId, {
        commitStatus: "pending",
      }),
    ).toHaveLength(0);
  } finally {
    host.release();
    await page.goto("about:blank");
    await page.unrouteAll({ behavior: "wait" });
    await host.close();
  }
});

for (const outcome of ["updated", "exhausted", "failed"] as const) {
  test(`keeps a committed story and composer usable after presentation is ${outcome}`, async ({
    page,
  }) => {
    const host = await startPresentationBrowserHost(outcome);
    try {
      await openPresentationSession(page, host);
      await composerInput(page).fill("Visit the library");
      await composerInput(page).press("Enter");
      await waitForTurnIdle(page);
      await expect.poll(() => host.mediaCalls.length).toBe(1);
      await expect(page.locator(".ui-narrative")).toContainText(
        "Public library story 1.",
      );
      await showStage(page);
      await expectPresentation(page);
      await expect(page.getByTestId("stage-plugin-panels")).toContainText(
        "No generated display",
      );
      host.release();
      await expect
        .poll(async () => (await host.jobs())[0]?.status)
        .toBe(outcome === "failed" ? "failed" : "succeeded");
      expect(host.mediaCalls).toHaveLength(1);
      if (outcome === "updated")
        await expectDisplay(
          page,
          "Generated display",
          "Source: Public library story 1.",
        );
      else
        await expect(page.getByTestId("stage-plugin-panels")).toContainText(
          "No generated display",
        );
      expect(
        (await host.store.listTraceEvents(host.sessionId)).find(
          (trace) =>
            trace.type === "presentation.completed" &&
            (trace.payload as { pluginId?: string }).pluginId ===
              "presentation-probe",
        )?.payload,
      ).toMatchObject({
        status:
          outcome === "updated"
            ? "updated"
            : outcome === "exhausted"
              ? "no-op"
              : "failed",
        ...(outcome === "updated"
          ? {}
          : {
              reason: outcome === "exhausted" ? "budget-exhausted" : "failed",
            }),
        budget: { calls: { used: 1, limit: 1 } },
      });
      // Stage treats a story already shown in another view as read and
      // opens the decision panel instead of replaying it.
      await expect(page.getByTestId("stage-choices")).toBeVisible();
      await expect(page.getByTestId("stage-error")).toBeHidden();
      const hydrated = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/sessions/${host.sessionId}/view` && response.ok(),
      );
      await page.reload();
      await hydrated;
      // The view mode is not kept across a reload; reopen the stage.
      await page.getByRole("button", { name: "舞台", exact: true }).click();
      await expect(page.getByTestId("stage-choices")).toBeVisible();
      await expect(page.getByTestId("stage-error")).toBeHidden();
      await expectPresentation(page);
      if (outcome === "updated")
        await expectDisplay(
          page,
          "Generated display",
          "Source: Public library story 1.",
        );
      else
        await expect(page.getByTestId("stage-plugin-panels")).toContainText(
          "No generated display",
        );
      await page.getByRole("button", { name: "阅读", exact: true }).click();
      await expect(composer(page)).toHaveAttribute("data-executing", "false");
      await expect(composerInput(page)).toBeEnabled();
      await expect(page.getByTestId("notice-no-story-plugin")).toBeHidden();
      await expect(page.locator(".ui-narrative")).toContainText(
        "Public library story 1.",
      );
    } finally {
      host.release();
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "wait" });
      await host.close();
    }
  });
}
