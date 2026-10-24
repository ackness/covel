import assert from "node:assert/strict";
import path from "node:path";

/** Exercise the shipped renderer and preload without starting a model call. */
export async function verifyArtifactUi(page, version, evidence) {
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/session(?:[/?#]|$)/, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => Boolean(window.covelIpc));
  assert.equal(await page.evaluate(() => window.covelIpc?.appVersion), version);
  const guide = page.getByTestId("onboarding-wizard");
  await guide
    .getByRole("button", { name: "Browse worlds first", exact: true })
    .click({ timeout: 30_000 });
  const enter = page
    .getByRole("button", { name: "Enter", exact: true })
    .filter({ visible: true })
    .first();
  await enter.waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(evidence, "world-list.png") });
  await enter.click();
  const start = page
    .getByRole("button", { name: "Start Game", exact: true })
    .filter({ visible: true })
    .first();
  const language = page.getByRole("button", { name: /Continue in/ });
  await start.or(language).first().waitFor({ timeout: 30_000 });
  if (await language.isVisible()) await language.click();
  await start.waitFor({ timeout: 30_000 });
  await start.click({ trial: true, timeout: 30_000 });
  await page.screenshot({
    path: path.join(evidence, "session-preparation.png"),
  });
  await page.reload();
  await start.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.covelIpc));
  assert.equal(await page.evaluate(() => window.covelIpc.appVersion), version);
}
