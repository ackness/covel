import { expect, test, type Page } from "@playwright/test";
import { startStageRenderHost } from "../../apps/server/tests/helpers/stage-render-browser.js";
import {
  composer,
  composerInput,
  seedAppSettings,
  waitForTurnIdle,
} from "./helpers/player.js";

type Host = Awaited<ReturnType<typeof startStageRenderHost>>;
test.use({ reducedMotion: "no-preference" });

async function openSession(page: Page, host: Host) {
  await seedAppSettings(page);
  const health = await fetch(`${host.baseUrl}/api/health`).then((response) =>
    response.json(),
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config/info")
      return route.fulfill({ json: { isDesktop: false } });
    if (url.pathname === "/api/health")
      return route.fulfill({
        json: {
          ...health,
          storage: {
            ...health.storage,
            data: { ...health.storage?.data, frontendMode: "remote" },
          },
        },
      });
    await route.continue({
      url: `${host.baseUrl}${url.pathname}${url.search}`,
    });
  });
  const hydration = ["view", "plugins", "ui-slots"].map((resource) =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/sessions/${host.sessionId}/${resource}` && response.ok(),
    ),
  );
  await page.goto(`/session?sid=${host.sessionId}`);
  await Promise.all(hydration);
  await expect(composerInput(page)).toBeVisible();
  await composerInput(page).fill("Establish the scene");
  await composerInput(page).press("Enter");
  await expect(page.getByTestId("story-segments")).toContainText(
    "Public dialogue 1.",
  );
  await waitForTurnIdle(page);
}

const actor = (page: Page, id: string) =>
  page.locator(`.ui-stage-sprite[data-character-id="${id}"]`);
async function freezeDepartures(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.evaluate(() => {
    const paused = new WeakSet<Animation>();
    new MutationObserver(() => {
      for (const element of document.querySelectorAll(
        '.ui-stage-sprite[data-phase="exit"]',
      )) {
        // Flush CSS and pause the actual outer exit, leaving its name intact.
        if (getComputedStyle(element).animationName === "none") continue;
        for (const animation of element.getAnimations()) {
          if (!paused.has(animation)) {
            animation.pause();
            paused.add(animation);
          }
        }
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-phase"],
    });
  });
}

async function finishExit(page: Page, id: string) {
  await actor(page, id).evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish();
  });
  await page.clock.runFor(32);
  await expect(actor(page, id)).toHaveCount(0);
}

async function closeHost(page: Page, host: Host) {
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "wait" });
  await host.close();
}

test("bundled dialogue portraits enlarge and a story departure fades without another projection", async ({
  page,
}) => {
  const host = await startStageRenderHost();
  try {
    await openSession(page, host);
    const portrait = page
      .getByTestId("story-segments")
      .getByRole("button", { name: "放大立绘" });
    await expect(portrait).toBeVisible();
    await expect(portrait.locator("img")).toBeVisible();
    await expect(portrait.locator("img")).toHaveJSProperty("naturalWidth", 28);
    await portrait.click();
    await expect(page.getByRole("dialog").locator("img")).toBeVisible();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByTestId("story-segments")).toContainText(
      "A readable line without a portrait.",
    );
    await page.getByRole("button", { name: "舞台视图", exact: true }).click();
    await expect(actor(page, "mira")).toBeVisible();
    await expect(actor(page, "theo")).toBeVisible();
    await freezeDepartures(page);
    await page.getByTestId("stage-decision-input").fill("Theo leaves");
    await page.getByTestId("stage-decision-input").press("Enter");
    await expect
      .poll(async () => {
        await page.clock.runFor(16);
        return actor(page, "theo").getAttribute("data-phase");
      })
      .toBe("exit");
    await expect(actor(page, "theo")).toHaveCSS(
      "animation-name",
      "ui-stage-fade-out",
    );
    await expect(actor(page, "theo")).toHaveAttribute("aria-hidden", "true");
    const current = await host.store.getPluginData(
      host.sessionId,
      "scene-stage",
      "direction",
      "current",
    );
    expect(current?.value).toMatchObject({
      actors: [expect.objectContaining({ characterId: "mira" })],
    });
    await finishExit(page, "theo");
    await page.clock.resume();
    await page.getByRole("button", { name: "解析视图", exact: true }).click();
    await expect(page.getByTestId("story-segments")).toContainText([
      "Public dialogue 1.",
      "Public dialogue 2.",
    ]);
    await waitForTurnIdle(page);
    await expect(composerInput(page)).toBeEnabled();
    const hydrated = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/sessions/${host.sessionId}/view`) &&
        response.ok(),
    );
    await page.reload();
    await hydrated;
    await expect(composerInput(page)).toBeVisible();
    await page.getByRole("button", { name: "舞台视图", exact: true }).click();
    await expect(actor(page, "mira")).toBeVisible();
    await expect(actor(page, "theo")).toHaveCount(0);
    await expect(page.locator('[data-phase="exit"]')).toHaveCount(0);
    await expect(page.getByTestId("stage-error")).toBeHidden();
    await expect(page.getByTestId("stage-decision-input")).toBeEnabled();
  } finally {
    await closeHost(page, host);
  }
});

test("full cast updates preserve newcomers and explicit none and reduced motion cut immediately", async ({
  page,
}) => {
  const host = await startStageRenderHost();
  try {
    await openSession(page, host);
    await page.getByRole("button", { name: "舞台视图", exact: true }).click();
    const cast = (...ids: string[]) => ({
      actors: ids.map((id) => ({ characterId: id, displayName: id })),
      retainWhenEmpty: false,
    });
    await host.publishCast(cast("mira", "theo", "cam", "dev"));
    await expect(
      page.locator('.ui-stage-sprite[data-phase="present"]'),
    ).toHaveCount(4);
    const oldLeft = await actor(page, "dev").evaluate(
      (element) => (element as HTMLElement).style.left,
    );
    await freezeDepartures(page);
    await host.publishCast(cast("mira", "theo", "cam", "eli"));
    await expect
      .poll(async () => {
        await page.clock.runFor(16);
        return page.locator(".ui-stage-sprite").count();
      })
      .toBe(5);
    await expect(actor(page, "eli")).toHaveAttribute("data-phase", "present");
    expect(
      await actor(page, "dev").evaluate(
        (element) => (element as HTMLElement).style.left,
      ),
    ).toBe(oldLeft);
    await expect(actor(page, "dev")).toHaveCSS(
      "animation-name",
      "ui-stage-fade-out",
    );
    await finishExit(page, "dev");
    await expect(page.locator(".ui-stage-sprite")).toHaveCount(4);
    await host.publishCast({
      ...cast("mira", "theo", "cam"),
      actors: [
        ...cast("mira", "theo", "cam").actors,
        {
          characterId: "eli",
          displayName: "Eli",
          exiting: true,
          transition: "none",
        },
      ],
    });
    await expect(actor(page, "eli")).toHaveCount(0);
    await host.publishCast(cast("mira", "theo", "cam"));
    await page.clock.runFor(500);
    await expect(actor(page, "eli")).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await host.publishCast(cast("mira"));
    await expect(actor(page, "theo")).toHaveCount(0);
    await expect(actor(page, "cam")).toHaveCount(0);
    await expect(page.locator('[data-phase="exit"]')).toHaveCount(0);
    await page.clock.resume();
    await expect(page.getByTestId("stage-decision-input")).toBeEnabled();
    await page.getByRole("button", { name: "解析视图", exact: true }).click();
    await expect(composer(page)).toHaveAttribute("data-executing", "false");
    await expect(composerInput(page)).toBeEnabled();
  } finally {
    await closeHost(page, host);
  }
});
