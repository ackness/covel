import { test, expect, type Page } from "@playwright/test";
import {
  actionableInteractionSubmits,
  composerInput,
  expectPlayerCanAct,
  seedAppSettings,
  selectWorldByText,
  sendPlayerMessage,
  useServerWorlds,
  waitForTurnIdle,
  waitForTurnStarted,
} from "./helpers/player.js";

const liveLlmEnabled = /^(1|true|yes|on)$/i.test(
  process.env.LIVE_LLM_ENABLED ?? "",
);

/**
 * Real game session E2E — 3 rounds of interaction:
 *
 *   Start Game → session_start (narrator/npc-init/init-wizard fire)
 *   Round 1: Enter character name → Submit → AI responds (user.input #1)
 *   Round 2: Send manual message → AI responds → Assert guide plugin triggered
 *   Round 3: Send another message → AI responds → Assert guide plugin triggered
 *
 * Guide plugin (guide) triggers on "user.input" only.
 * We verify it triggers stably across rounds 2 and 3.
 */

test.describe.configure({ mode: "serial" });

test.describe("Game Session — 3 Round Flow", () => {
  test.skip(
    !liveLlmEnabled,
    "Set LIVE_LLM_ENABLED=1 to run provider-backed browser tests",
  );
  test.use({ viewport: { width: 1280, height: 720 } });
  // Even with unrelated optional plugins disabled below, start-up and three
  // provider-backed rounds can exceed ten minutes on queued external models.
  test.setTimeout(1_200_000);
  let hasProviderKeys = false;

  test.beforeAll(async ({ request }) => {
    const res = await request.get("/api/provider-keys");
    expect(res.ok()).toBeTruthy();
    const { keys, providers } = (await res.json()) as {
      keys?: Record<string, string>;
      providers?: Record<string, { configured?: boolean }>;
    };
    hasProviderKeys =
      Object.keys(keys ?? {}).length > 0 ||
      Object.values(providers ?? {}).some((provider) => provider.configured);
  });

  test("server has provider keys", async () => {
    test.skip(!hasProviderKeys, "No provider keys configured for live LLM e2e");
    expect(hasProviderKeys).toBeTruthy();
  });

  test("3 rounds: char creation → message → message, guide triggers", async ({
    page,
  }) => {
    test.skip(!hasProviderKeys, "No provider keys configured for live LLM e2e");

    // This flow asserts Mistport's authored plugin package. The default memory
    // deployment is browser-private and exposes same-named minimal starter
    // worlds, so opt into the server-backed catalog explicitly.
    await useServerWorlds(page);
    await seedAppSettings(page);

    // ── Start Game ───────────────────────────────────────────
    await page.goto("/session");
    await selectWorldByText(page, /mistport|雾港/i);

    const startButton = page
      .getByRole("button", { name: /^(start game|开始游戏)$/i })
      .first();
    await expect(startButton).toBeVisible({ timeout: 10_000 });
    await expect(startButton).toBeEnabled({ timeout: 30_000 });
    await keepFocusedGuidePluginSet(page);
    await expect(startButton).toBeEnabled({ timeout: 30_000 });
    await startButton.click();

    // Wait for game view
    await expect(composerInput(page)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/sid=/, { timeout: 10_000 });

    const beginButton = page.getByRole("button", {
      name: /开始冒险|Begin Adventure/i,
    });
    await expect(beginButton).toBeVisible({ timeout: 10_000 });
    await beginButton.click();

    // Wait for start_session to complete (narrator + init plugins)
    await waitForTurnStarted(page);
    await waitForTurnIdle(page);
    await page.screenshot({
      path: "tests/e2e/artifacts/game-r0-session-start.png",
    });

    // ══════════════════════════════════════════════════════════
    // Round 1: Character creation — enter name and submit
    // ══════════════════════════════════════════════════════════
    await handleCharacterCreation(page);
    await waitForTurnStarted(page);
    await waitForTurnIdle(page);
    await page.screenshot({
      path: "tests/e2e/artifacts/game-r1-char-created.png",
    });

    // Chat history is virtualized, so assert against the current turn rather
    // than counting all previously rendered guide blocks.
    const currentGuide = page
      .locator(
        'main .chat-row[data-turn-current="true"][data-row-kind="message"]',
      )
      .filter({ has: page.getByText("§ GUIDE", { exact: true }) });

    // ══════════════════════════════════════════════════════════
    // Round 2: Send manual message
    // ══════════════════════════════════════════════════════════
    await sendPlayerMessage(page, "我环顾四周，观察周围的环境");
    await page.screenshot({ path: "tests/e2e/artifacts/game-r2-sent.png" });

    await waitForTurnIdle(page);
    await page.screenshot({ path: "tests/e2e/artifacts/game-r2-response.png" });

    await expect(currentGuide).toHaveCount(1);
    await expect(currentGuide).toHaveAttribute("data-turn-id", /.+/);
    const secondTurnId = await currentGuide.getAttribute("data-turn-id");

    // The guide panel is a suggestion surface — it must not lock free text.
    await expectPlayerCanAct(page);

    // ══════════════════════════════════════════════════════════
    // Round 3: Send another message
    // ══════════════════════════════════════════════════════════
    // Guide suggestions only edit the composer draft. Sending explicitly also
    // waits for a new turn to start, so an idle previous turn cannot pass here.
    await sendPlayerMessage(page, "我走向最近的建筑物");
    await page.screenshot({ path: "tests/e2e/artifacts/game-r3-sent.png" });

    await waitForTurnIdle(page);
    await page.screenshot({ path: "tests/e2e/artifacts/game-r3-response.png" });

    await expect(currentGuide).toHaveCount(1);
    await expect(currentGuide).toHaveAttribute("data-turn-id", /.+/);
    await expect(currentGuide).not.toHaveAttribute(
      "data-turn-id",
      secondTurnId!,
    );

    // ── Final verification ───────────────────────────────────
    expect(page.url()).toMatch(/sid=/);
    await expectPlayerCanAct(page);
  });
});

// ── Helpers ──────────────────────────────────────────────────────
// Shared session helpers live in ./helpers/player.ts.

/**
 * Fill and submit the character creation form.
 * The form may have single (name only) or multiple fields.
 */
async function handleCharacterCreation(page: Page) {
  const formInputs = page.locator(
    "main input.ui-input-shell:enabled:visible, main textarea.ui-input-shell:enabled:visible",
  );
  const count = await formInputs.count();

  for (let i = 0; i < count; i++) {
    const field = formInputs.nth(i);
    const placeholder = (await field.getAttribute("placeholder")) ?? "";
    await field.fill(guessFieldValue(placeholder));
  }

  // Handle <select> dropdowns
  const selects = page.locator("main select.ui-input-shell:enabled:visible");
  for (let i = 0; i < (await selects.count()); i++) {
    const sel = selects.nth(i);
    const options = sel.locator("option");
    if ((await options.count()) > 1) {
      const val = await options.nth(1).getAttribute("value");
      if (val) await sel.selectOption(val);
    }
  }

  // Submit — target the stable data-testid, not the LLM-generated label.
  const submitBtn = actionableInteractionSubmits(page);
  await expect(submitBtn.last()).toBeVisible({ timeout: 180_000 });
  // The transcript is chronological; the last visible live block is current.
  await submitBtn.last().click();
}

/**
 * Keep this live spec focused on the contract it asserts. Mistport's default
 * pack deliberately enables expensive retrieval, codex, memory, and character
 * tracking runtimes; those have their own coverage and can push three external
 * model rounds beyond the browser-test budget.
 */
async function keepFocusedGuidePluginSet(page: Page) {
  await page
    .locator('button[aria-controls="plugin-selection-card-content"]')
    .click();
  await page.getByTestId("advanced-plugin-settings").locator("summary").click();
  const unrelatedOptionalPlugins = [
    "codex",
    "npc-graph",
    "memory",
    "living-world-rules",
    "character-blueprint",
    "character-presence",
    "cost-gate",
  ];
  for (const pluginId of unrelatedOptionalPlugins) {
    const toggle = page
      .locator(`[data-plugin-id="${pluginId}"]`)
      .getByRole("switch");
    if (
      (await toggle.isEnabled()) &&
      (await toggle.getAttribute("aria-checked")) === "true"
    ) {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
    }
  }
}

function guessFieldValue(placeholder: string): string {
  const p = placeholder.toLowerCase();
  if (p.includes("name") || p.includes("名")) return "林风";
  if (p.includes("class") || p.includes("职")) return "剑客";
  if (p.includes("race") || p.includes("种族")) return "人类";
  if (p.includes("age") || p.includes("年龄")) return "25";
  if (p.includes("background") || p.includes("背景")) return "流浪武者";
  if (p.includes("gender") || p.includes("性别")) return "男";
  if (p.includes("skill") || p.includes("技能")) return "剑术";
  if (p.includes("origin") || p.includes("出身")) return "江湖";
  return "测试角色";
}
