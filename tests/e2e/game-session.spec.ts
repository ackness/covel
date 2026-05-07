import { test, expect, type Page } from "@playwright/test";

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
  test.use({ viewport: { width: 1280, height: 720 } });
  test.setTimeout(600_000); // 10 min for 3 rounds of LLM calls
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

    await seedAppSettings(page);

    // ── Start Game ───────────────────────────────────────────
    await page.goto("/session");
    await selectWorldByText(page, /cloudmere|九州・云梦泽/i);

    const startButton = page.locator("button", {
      hasText: /start game|开始游戏/i,
    });
    await expect(startButton).toBeVisible({ timeout: 10_000 });
    await startButton.click();

    // Wait for game view
    await expect(page.locator("input[type=text]").last()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/sid=/, { timeout: 10_000 });

    const beginButton = page.getByRole("button", {
      name: /开始冒险|Begin Adventure/i,
    });
    await expect(beginButton).toBeVisible({ timeout: 10_000 });
    await beginButton.click();

    // Wait for start_session to complete (narrator + init plugins)
    await waitForExecDone(page);
    await page.screenshot({
      path: "tests/e2e/artifacts/game-r0-session-start.png",
    });

    // ══════════════════════════════════════════════════════════
    // Round 1: Character creation — enter name and submit
    // ══════════════════════════════════════════════════════════
    await handleCharacterCreation(page);
    await waitForExecDone(page);
    await page.screenshot({
      path: "tests/e2e/artifacts/game-r1-char-created.png",
    });

    // After round 1 (char creation = user.input), guide MAY trigger.
    // But sometimes it doesn't on the first user.input after session_start.
    const guideR1 = await detectGuideOutput(page);
    console.log(`Round 1 (char creation): guide triggered = ${guideR1}`);

    // ══════════════════════════════════════════════════════════
    // Round 2: Send manual message
    // ══════════════════════════════════════════════════════════
    await sendPlayerMessage(page, "我环顾四周，观察周围的环境");
    await page.screenshot({ path: "tests/e2e/artifacts/game-r2-sent.png" });

    await waitForExecDone(page);
    await page.screenshot({ path: "tests/e2e/artifacts/game-r2-response.png" });

    const guideR2 = await detectGuideOutput(page);
    console.log(`Round 2 (manual message): guide triggered = ${guideR2}`);
    expect(guideR2).toBeTruthy();

    // ══════════════════════════════════════════════════════════
    // Round 3: Send another message (or click guide choice)
    // ══════════════════════════════════════════════════════════
    // Try clicking a guide option first; if none, send a manual message
    const clickedGuide = await tryClickGuideOption(page);
    if (clickedGuide) {
      await page.screenshot({
        path: "tests/e2e/artifacts/game-r3-guide-clicked.png",
      });
    } else {
      await sendPlayerMessage(page, "我走向最近的建筑物");
      await page.screenshot({ path: "tests/e2e/artifacts/game-r3-sent.png" });
    }

    await waitForExecDone(page);
    await page.screenshot({ path: "tests/e2e/artifacts/game-r3-response.png" });

    const guideR3 = await detectGuideOutput(page);
    console.log(`Round 3: guide triggered = ${guideR3}`);
    expect(guideR3).toBeTruthy();

    // ── Final verification ───────────────────────────────────
    expect(page.url()).toMatch(/sid=/);
    const finalInput = page.locator("input[type=text]").last();
    await expect(finalInput).toBeEnabled({ timeout: 5_000 });
  });
});

// ── Helpers ──────────────────────────────────────────────────────

async function seedAppSettings(page: Page) {
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

async function selectWorldByText(page: Page, text: RegExp) {
  const worldCard = page.locator("article").filter({ hasText: text }).first();
  await expect(worldCard).toBeVisible({ timeout: 15_000 });
  await worldCard.click();
}

/**
 * Wait for execution to complete.
 * Fast check first (10s), then slow fallback (3 min) for multi-runtime turns.
 */
async function waitForExecDone(page: Page) {
  const input = page.locator("input[type=text]").last();
  try {
    await expect(input).toBeEnabled({ timeout: 10_000 });
  } catch {
    await expect(input).toBeEnabled({ timeout: 180_000 });
  }
}

/**
 * Send a player message via the game input.
 */
async function sendPlayerMessage(page: Page, text: string) {
  const input = page.locator("input[type=text]").last();
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(text);
  const container = input.locator("..");
  await container.locator("button").last().click();
  // Verify message appears in chat
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Fill and submit the character creation form.
 * The form may have single (name only) or multiple fields.
 */
async function handleCharacterCreation(page: Page) {
  const formInputs = page.locator("[id^=block-field-]");
  const count = await formInputs.count();
  if (count === 0) return;

  for (let i = 0; i < count; i++) {
    const field = formInputs.nth(i);
    if (!(await field.isVisible())) continue;
    const placeholder = (await field.getAttribute("placeholder")) ?? "";
    await field.fill(guessFieldValue(placeholder));
  }

  // Handle <select> dropdowns
  const selects = page.locator("select");
  for (let i = 0; i < (await selects.count()); i++) {
    const sel = selects.nth(i);
    if (!(await sel.isVisible())) continue;
    const options = sel.locator("option");
    if ((await options.count()) > 1) {
      const val = await options.nth(1).getAttribute("value");
      if (val) await sel.selectOption(val);
    }
  }

  // Submit
  const submitBtn = page.locator("button", {
    hasText: /confirm|确认|submit|提交|create|创建/i,
  });
  if (
    await submitBtn
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await submitBtn.first().click();
  }
}

/**
 * Detect guide plugin output (choice_set or action_guide blocks).
 */
async function detectGuideOutput(page: Page): Promise<boolean> {
  // choice_set: ghost-variant buttons in cards (Button renders data-variant="ghost", not class)
  const choiceButtons = page.locator(
    "main button[data-variant=ghost][class*=justify-start]",
  );
  if ((await choiceButtons.count()) > 0) return true;

  // choice_set: by container class (max-w-md card)
  const choiceCards = page.locator("main div[class*=max-w-md]");
  if ((await choiceCards.count()) > 0) return true;

  // action_guide: by container class (max-w-lg card)
  const guideCards = page.locator("main div[class*=max-w-lg]");
  if ((await guideCards.count()) > 0) return true;

  // action_guide: color-bordered category divs
  const colorDivs = page.locator(
    "main div[class*=border-green-500], main div[class*=border-red-500], main div[class*=border-amber-500], main div[class*=border-purple-500]",
  );
  if ((await colorDivs.count()) > 0) return true;

  // action_guide: categorized suggestions with style labels
  const actionGuide = page.locator(
    "text=/稳妥|激进|创意|狂野|疯狂|safe|aggressive|creative|wild/i",
  );
  if ((await actionGuide.count()) > 0) return true;

  return false;
}

/**
 * Try clicking a guide option. Returns true if successful.
 */
async function tryClickGuideOption(page: Page): Promise<boolean> {
  // Try choice_set buttons (ghost-variant with justify-start)
  const choiceBtn = page
    .locator("main button[data-variant=ghost][class*=justify-start]")
    .first();
  if (await choiceBtn.isVisible().catch(() => false)) {
    if (await choiceBtn.isEnabled()) {
      await choiceBtn.click();
      return true;
    }
  }
  // Try action_guide suggestion buttons (inside color-bordered category divs)
  const guideBtn = page.locator("main div[class*=max-w-lg] button").first();
  if (await guideBtn.isVisible().catch(() => false)) {
    if (await guideBtn.isEnabled()) {
      await guideBtn.click();
      return true;
    }
  }
  return false;
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
