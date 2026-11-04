import { expect, test, type Page } from "@playwright/test";
import { startPresentationBrowserHost } from "../../apps/server/tests/helpers/presentation-browser.js";
import {
  composer,
  composerInput,
  seedAppSettings,
  waitForTurnIdle,
} from "./helpers/player.js";

type PresentationHost = Awaited<
  ReturnType<typeof startPresentationBrowserHost>
>;

async function openPresentationSession(page: Page, host: PresentationHost) {
  await seedAppSettings(page);
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
