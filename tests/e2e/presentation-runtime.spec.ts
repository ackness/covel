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
  await expect(page.getByTestId("no-story-plugin")).toBeHidden();
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
    expect(
      (
        await host.store.getPluginData(
          host.sessionId,
          "scene-stage",
          "stage",
          "current",
        )
      )?.value,
    ).toMatchObject({ sceneId: "library" });
    expect(
      (
        await host.store.getPluginData(
          host.sessionId,
          "scene-stage",
          "direction",
          "current",
        )
      )?.value,
    ).toMatchObject({
      actors: [expect.objectContaining({ characterId: "mira", active: true })],
    });
    expect(
      (
        await host.store.getPluginData(
          host.sessionId,
          "soundtrack",
          "state",
          "mood",
        )
      )?.value,
    ).toMatchObject({ mood: "Tense" });
    expect(
      await host.store.getPluginData(
        host.sessionId,
        "presentation-probe",
        "display",
        "current",
      ),
    ).toBeNull();
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
        body: JSON.stringify({ value: { title: "Explicit newer display" } }),
      },
    );
    expect(override.ok, await override.text()).toBe(true);
    host.release();
    await expect
      .poll(
        async () =>
          (await host.jobs()).filter((job) => job.status === "succeeded")
            .length,
      )
      .toBe(2);
    expect(
      (
        await host.store.getPluginData(
          host.sessionId,
          "presentation-probe",
          "display",
          "current",
        )
      )?.value,
    ).toEqual({ title: "Explicit newer display" });
    expect(
      (await host.store.listTraceEvents(host.sessionId)).filter(
        (trace) =>
          trace.type === "presentation.completed" &&
          (trace.payload as { reason?: string }).reason === "superseded",
      ),
    ).toHaveLength(2);
    await page.getByRole("button", { name: "舞台视图", exact: true }).click();
    await expect(page.getByTestId("stage-view")).toBeVisible();
    // Stage treats a story already shown in another view as read and
    // opens the decision panel instead of replaying it.
    await expect(page.getByTestId("stage-choices")).toBeVisible();
    await page.reload();
    // The view mode is not kept across a reload; reopen the stage.
    await page.getByRole("button", { name: "舞台视图", exact: true }).click();
    await expect(page.getByTestId("stage-choices")).toBeVisible();
    await page.getByRole("button", { name: "解析视图", exact: true }).click();
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
      expect(
        await host.store.getPluginData(
          host.sessionId,
          "presentation-probe",
          "display",
          "current",
        ),
      ).toBeNull();
      host.release();
      await expect
        .poll(async () => (await host.jobs())[0]?.status)
        .toBe(outcome === "failed" ? "failed" : "succeeded");
      expect(host.mediaCalls).toHaveLength(1);
      expect(
        (
          await host.store.getPluginData(
            host.sessionId,
            "presentation-probe",
            "display",
            "current",
          )
        )?.value ?? null,
      ).toEqual(outcome === "updated" ? { title: "Generated display" } : null);
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
      await page.getByRole("button", { name: "舞台视图", exact: true }).click();
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
      await page.getByRole("button", { name: "舞台视图", exact: true }).click();
      await expect(page.getByTestId("stage-choices")).toBeVisible();
      await expect(page.getByTestId("stage-error")).toBeHidden();
      await page.getByRole("button", { name: "解析视图", exact: true }).click();
      await expect(composer(page)).toHaveAttribute("data-executing", "false");
      await expect(composerInput(page)).toBeEnabled();
      await expect(page.getByTestId("no-story-plugin")).toBeHidden();
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
