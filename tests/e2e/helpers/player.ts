/**
 * Shared player-facing helpers for the session E2E specs.
 *
 * The composer exposes two orthogonal flags (`message-composer.tsx`):
 *   data-executing — a turn is running; the composer stays usable (steering)
 *   data-blocked   — a must-answer block (form / choice) is waiting
 *
 * Specs previously inferred turn state from `input:disabled`, which conflated
 * the two and silently passed while a turn was still running — `toBeEnabled()`
 * is already true mid-turn. Read the flags instead.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export function composer(page: Page): Locator {
  return page.getByTestId("game-composer");
}

export function composerInput(page: Page): Locator {
  return page.getByTestId("game-composer-input");
}

/** Seed onboarding + locale so specs land straight on the world list. */
export async function seedAppSettings(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "covel:settings",
      JSON.stringify({
        schemaVersion: 1,
        savedAt: new Date().toISOString(),
        entries: {
          "ui.onboardedVersion": 3,
          "ui.locale": "zh-CN",
        },
      }),
    );
  });
}

export async function selectWorldByText(page: Page, text: RegExp) {
  const worldCard = page.locator("article").filter({ hasText: text }).first();
  await expect(worldCard).toBeVisible({ timeout: 15_000 });
  await worldCard.click();
}

/**
 * Wait until no turn is running. Multi-runtime turns with live LLM calls run
 * well past a minute, so the budget is generous — but unlike the old helper
 * this actually waits for the turn rather than for an enabled input.
 */
export async function waitForTurnIdle(page: Page, timeout = 240_000) {
  await expect(composer(page)).toHaveAttribute("data-executing", "false", {
    timeout,
  });
}

/** Type into the main composer and send with the button. */
export async function sendPlayerMessage(page: Page, text: string) {
  const input = composerInput(page);
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(text);
  await composer(page).getByRole("button").last().click();
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 10_000 });
}

/**
 * The core player-agency invariant: once a turn settles, the player must have
 * a way to act. The composer may only be locked while a must-answer block is
 * on screen — optional suggestion panels must never lock it.
 *
 * This is what catches a plugin panel (scene-prompts, guide, …) accidentally
 * being classified as pending and freezing free-text input for the whole turn.
 */
export async function expectPlayerCanAct(page: Page) {
  await waitForTurnIdle(page);

  const mustAnswer = page.getByTestId("interaction-submit");
  const hasMustAnswer = await mustAnswer
    .first()
    .isVisible()
    .catch(() => false);

  if (hasMustAnswer) {
    await expect(mustAnswer.first()).toBeEnabled();
    return;
  }

  await expect(
    composer(page),
    "no must-answer block on screen, so the composer must accept free text",
  ).toHaveAttribute("data-blocked", "false");
  await expect(composerInput(page)).toBeEnabled();
}
