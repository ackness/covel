import { test, expect, type Page } from "@playwright/test";
import {
  actionableInteractionSubmits,
  composerInput,
  expectPlayerCanAct,
  seedAppSettings,
  useServerWorlds,
  waitForTurnIdle,
  waitForTurnStarted,
} from "./helpers/player.js";

const liveLlmEnabled = /^(1|true|yes|on)$/i.test(
  process.env.LIVE_LLM_ENABLED ?? "",
);

/**
 * AI World Generation E2E — tests the full flow:
 *
 *   1. Navigate to world selection screen
 *   2. Click "AI 创建世界" to open the generator dialog
 *   3. Enter a world prompt (or click an example)
 *   4. Review the package plan and click "开始构筑" to start generation
 *   5. Wait for SSE progress: generating → validating → saving → done
 *   6. Verify the new world appears in the world list
 *   7. Verify the world has dimensions via API
 *   8. Start a game with the world → verify character creation has schema-derived fields
 */

test.describe("AI World Generation", () => {
  test.skip(
    !liveLlmEnabled,
    "Set LIVE_LLM_ENABLED=1 to run provider-backed browser tests",
  );
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 1280, height: 720 } });
  test.setTimeout(600_000); // 10 min — world gen + game start with LLM calls
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

  test("server has provider keys for generation", async () => {
    test.skip(!hasProviderKeys, "No provider keys configured for live LLM e2e");
    expect(hasProviderKeys).toBeTruthy();
  });

  let createdWorldName: string | null = null;
  let createdWorldId: string | null = null;

  test("generate world via AI and verify it appears", async ({ page }) => {
    test.skip(!hasProviderKeys, "No provider keys configured for live LLM e2e");

    // The following serial tests inspect the generated record through the
    // server API and open it in a fresh page. Persist it in the transient
    // server store instead of a per-test BrowserVault context.
    await useServerWorlds(page);
    await seedAppSettings(page);

    // ── Navigate to world selection ──
    await page.goto("/session");
    const worldCards = page.locator("article").filter({
      has: page.locator("h2"),
    });
    await expect(worldCards.first()).toBeVisible({ timeout: 15_000 });
    const initialWorldCount = await worldCards.count();
    const initialWorldIds = new Set(
      (await worldCards.allTextContents()).flatMap((text) => {
        const id = text.match(/№\s*\d+\s*·\s*([A-Za-z0-9_-]+)/)?.[1];
        return id ? [id] : [];
      }),
    );
    console.log(`Initial world count: ${initialWorldCount}`);

    // ── Open AI World Generator dialog ──
    const aiCreateBtn = page.locator("button", {
      hasText: /AI 创建世界|AI Create/i,
    });
    await expect(aiCreateBtn).toBeVisible();
    await aiCreateBtn.click();

    // Verify dialog opened
    const dialog = page.locator("[role=dialog]");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.locator("text=AI 创建世界").first()).toBeVisible();

    await page.screenshot({ path: "tests/e2e/artifacts/world-gen-dialog.png" });

    // ── Enter world prompt ──
    const promptTextarea = dialog.locator("#world-prompt");
    await expect(promptTextarea).toBeVisible();
    await promptTextarea.fill(
      "一个漂浮在云海之上的蒸汽朋克城市，居民靠飞艇贸易，城市由蒸汽驱动的巨大齿轮维持悬浮",
    );

    // Verify character count updates
    await expect(dialog.locator("text=/\\d+\\/4000/")).toBeVisible();

    // ── Click generate ──
    const generateBtn = dialog.locator("button", {
      hasText: /开始构筑|Start Building|生成世界|Generate/i,
    });
    await expect(generateBtn).toBeEnabled();
    await generateBtn.click();

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-started.png",
    });

    // ── Wait for generation progress ──
    // Phase 1: Generating
    const progressIndicator = dialog.locator(
      "text=/AI 正在构建|构建世界|generating/i",
    );
    await expect(progressIndicator.first()).toBeVisible({ timeout: 10_000 });
    console.log("Phase: generating");

    // The textarea should be disabled during generation
    await expect(promptTextarea).toBeDisabled();

    // Cancel button should be visible during generation
    const cancelBtn = dialog.locator("button", {
      hasText: /取消|cancel/i,
    });
    await expect(cancelBtn).toBeVisible();

    // ── Wait for completion ──
    // A full three-attempt provider retry can exceed four minutes. Poll all
    // terminal signals together so an error is reported immediately and the
    // brief done indicator cannot race the dialog auto-close.
    const doneIndicator = dialog
      .locator("text=/世界创建完成|创建完成|World created/i")
      .first();
    const errorIndicator = dialog
      .locator("text=/生成失败|Generation failed|LLM error|timeout/i")
      .first();
    let terminalState = "pending";
    await expect
      .poll(
        async () => {
          if (await dialog.isHidden()) terminalState = "dialog-closed";
          else if (await errorIndicator.isVisible()) terminalState = "error";
          else if ((await updatedWorldCount(page)) === initialWorldCount + 1)
            terminalState = "world-created";
          else if (await doneIndicator.isVisible()) terminalState = "done";
          else terminalState = "pending";
          return terminalState;
        },
        // Three server attempts can each consume the 150s generation budget.
        // Leave enough room to observe the final SSE error instead of racing it.
        { timeout: 500_000, intervals: [1_000] },
      )
      .not.toBe("pending");

    if (terminalState === "error") {
      const errorText = await dialog.textContent();
      throw new Error(`World generation failed: ${errorText}`);
    }
    if (terminalState === "done") {
      console.log("Phase: done (saw indicator)!");
      await page.screenshot({ path: "tests/e2e/artifacts/world-gen-done.png" });
    } else {
      console.log(`Phase: done (${terminalState})!`);
    }
    if (await dialog.isVisible()) {
      await expect(dialog).toBeHidden({ timeout: 10_000 });
    }
    console.log("Dialog closed");

    // ── Verify new world appears in the list ──
    // Re-query world cards after generation
    const updatedWorldCards = page.locator("article").filter({
      has: page.locator("h2"),
    });
    await expect(updatedWorldCards).toHaveCount(initialWorldCount + 1, {
      timeout: 5_000,
    });
    console.log(`Updated world count: ${await updatedWorldCards.count()}`);

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-list.png",
    });

    // Find the new world (it should be in the list — check that there's one more)
    // Get all world names to find the newly created one
    const worldNames = page.locator("article h2");
    const names: string[] = [];
    for (let i = 0; i < (await worldNames.count()); i++) {
      const name = await worldNames.nth(i).textContent();
      if (name) names.push(name);
    }
    console.log(`World names: ${names.join(", ")}`);

    let newWorldIndex = -1;
    let newWorldId: string | undefined;
    for (let i = 0; i < (await updatedWorldCards.count()); i++) {
      const id = (await updatedWorldCards.nth(i).textContent())?.match(
        /№\s*\d+\s*·\s*([A-Za-z0-9_-]+)/,
      )?.[1];
      if (id && !initialWorldIds.has(id)) {
        newWorldIndex = i;
        newWorldId = id;
        break;
      }
    }
    expect(newWorldIndex).toBeGreaterThanOrEqual(0);
    expect(newWorldId).toBeTruthy();
    const newWorldCard = updatedWorldCards.nth(newWorldIndex);

    // The new world should have tags (AI-generated worlds include tags)
    const worldTags = newWorldCard.locator(".ui-tag");
    const tagCount = await worldTags.count();
    console.log(`New world tags: ${tagCount}`);

    // Save the generated world for subsequent tests. Use the id to avoid name
    // collisions from live model output.
    createdWorldName = (await newWorldCard.locator("h2").textContent()) ?? null;
    createdWorldId = newWorldId ?? null;
    expect(createdWorldName).toBeTruthy();
    console.log(`Created world: ${createdWorldName} (${createdWorldId})`);
  });

  test("verify world dimensions via API", async ({ request }) => {
    test.skip(!hasProviderKeys, "No provider keys configured for live LLM e2e");
    test.skip(!createdWorldId, "No world was created in previous test");

    // Fetch all worlds and find the newly created one
    const res = await request.get("/api/worlds");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    const worlds = data.items as Record<string, unknown>[];

    const created = worlds.find((w: Record<string, unknown>) => {
      return w.id === createdWorldId;
    });

    expect(created).toBeTruthy();
    console.log(`World ID: ${createdWorldId}`);

    // Verify dimensions exist and have content. The raw server API keeps
    // store-backed dimensions under metadata; the web client maps them to the
    // top-level `dimensions` field before rendering.
    const metadata = created.metadata as Record<string, unknown> | undefined;
    const dims = (created.dimensions ?? metadata?.dimensions) as
      Record<string, unknown> | undefined;
    expect(dims).toBeTruthy();
    console.log(`Dimensions keys: ${Object.keys(dims!).join(", ")}`);

    // Server-store saves persist dimensions under `metadata.dimensions` (the
    // durable, self-contained projection the web client maps to the top-level
    // `dimensions` field). The generator's file-package provenance
    // (`metadata.worldData.sources` targeting `world:metadata.dimensions`) is
    // intentionally stripped by `recordForStoreOnly` in
    // apps/server/src/routes/api/ai.ts — the temp world package those sources
    // point at is deleted right after generation, so retaining them would leave
    // dangling references.
    expect(metadata?.dimensions).toBeTruthy();
    expect(metadata?.generatedPackageSummary).toMatchObject({
      characters: expect.any(Number),
      lorebook: expect.any(Number),
      rules: expect.any(Number),
    });
    expect(
      (metadata?.generatedPackageSummary as { characters: number }).characters,
    ).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(metadata?.characterBlueprints)).toBe(true);
    expect(Array.isArray(metadata?.embeddedLorebook)).toBe(true);

    // At minimum, geography and tone should be generated
    const dimKeys = Object.keys(dims!);
    expect(dimKeys.length).toBeGreaterThanOrEqual(3);
    console.log(`Dimension count: ${dimKeys.length}/9`);

    // Log which dimensions were generated
    const expectedDims = [
      "geography",
      "factions",
      "powerSystem",
      "history",
      "economy",
      "socialStructure",
      "tone",
      "mechanics",
      "startingConditions",
    ];
    for (const key of expectedDims) {
      const present = key in dims!;
      console.log(`  ${present ? "✓" : "✗"} ${key}`);
    }
  });

  test("start game with AI world → verify character creation schema", async ({
    page,
  }) => {
    test.skip(!hasProviderKeys, "No provider keys configured for live LLM e2e");
    test.skip(!createdWorldId, "No world was created in previous test");

    await useServerWorlds(page);
    await seedAppSettings(page);

    // ── Navigate to world selection ──
    await page.goto("/session");
    const worldCards = page.locator("article").filter({
      has: page.locator("h2"),
    });
    await expect(worldCards.first()).toBeVisible({ timeout: 15_000 });

    // ── Select the AI-created world ──
    const createdWorldCard = page
      .locator("article")
      .filter({ hasText: `· ${createdWorldId}` });
    await expect(createdWorldCard.first()).toBeVisible({ timeout: 10_000 });
    await createdWorldCard
      .first()
      .getByRole("button", { name: /enter|进入/i })
      .click();

    // Verify prep screen
    const startButton = page
      .getByRole("button", { name: /^(start game|开始游戏)$/i })
      .first();
    await expect(startButton).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(createdWorldName!).first()).toBeVisible({
      timeout: 5_000,
    });

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-prep.png",
    });

    // ── Start the game ──
    await startButton.click();

    // Wait for game view (input field + sid in URL)
    await expect(composerInput(page)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/sid=/, { timeout: 10_000 });

    const beginButton = page.getByRole("button", {
      name: /开始冒险|Begin Adventure/i,
    });
    await expect(beginButton).toBeVisible({ timeout: 10_000 });
    await beginButton.click();

    // Wait for session_start to complete (narrator + npc-init + init-wizard fire)
    const formArea = page
      .locator("main")
      .locator("div")
      .filter({
        has: page.locator(".ui-input-shell"),
        hasNot: page.locator(".ui-composer-frame"),
      })
      .first();
    const textFields = formArea.locator(
      "input.ui-input-shell, textarea.ui-input-shell",
    );
    const selectFields = formArea.locator("select.ui-input-shell");
    await expect(formArea.locator(".ui-input-shell").first()).toBeVisible({
      timeout: 180_000,
    });
    console.log("Session started");

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-session-start.png",
    });

    // ── Verify character creation form ──
    // init-wizard should emit a character_creation block
    // If schema was generated by core-npc-init, the form has multiple fields (not just name)
    const textFieldCount = await textFields.count();
    const selectCount = await selectFields.count();
    const fieldCount = textFieldCount + selectCount;
    console.log(`Character creation fields: ${fieldCount}`);

    // There should be at least the name field
    expect(fieldCount).toBeGreaterThanOrEqual(1);

    // Check for select dropdowns (enum fields from schema, like faction/class/origin)
    console.log(`Select (enum) fields: ${selectCount}`);

    // Log all field info
    for (let i = 0; i < textFieldCount; i++) {
      const field = textFields.nth(i);
      const id = await field.getAttribute("id");
      const placeholder = await field.getAttribute("placeholder");
      const tagName = await field.evaluate((el) => el.tagName.toLowerCase());
      console.log(
        `  Field[${i}]: id="${id}" placeholder="${placeholder}" tag=${tagName}`,
      );
    }
    for (let i = 0; i < selectCount; i++) {
      const sel = selectFields.nth(i);
      const optionCount = await sel.locator("option").count();
      console.log(`  Select[${i}]: ${optionCount} options`);
    }

    // If core-npc-init generated a schema with bio fields, expect more than 1 field
    // (name + at least some bio fields like origin, class, etc.)
    if (fieldCount > 1 || selectCount > 0) {
      console.log(
        "✓ Character creation has schema-derived fields (multi-field form)",
      );
    } else {
      console.log(
        "△ Character creation has only name field (no schema or bio fields)",
      );
    }

    // The character_creation block should have a submit button. Target it by its
    // stable data-testid — the label is LLM-generated (e.g. "觉醒·踏入云海"), so
    // neither text-matching nor position (`.last()` grabs the execution-timeline
    // indicator) reliably finds it.
    const submitBtn = actionableInteractionSubmits(page);
    await expect(submitBtn.last()).toBeVisible({ timeout: 5_000 });

    // ── Fill the form and submit ──
    for (let i = 0; i < textFieldCount; i++) {
      const field = textFields.nth(i);
      if (!(await field.isVisible())) continue;
      const placeholder = (await field.getAttribute("placeholder")) ?? "";
      await field.fill(guessFieldValue(placeholder));
    }

    // Handle select fields
    for (let i = 0; i < selectCount; i++) {
      const sel = selectFields.nth(i);
      if (!(await sel.isVisible())) continue;
      const options = sel.locator("option");
      if ((await options.count()) > 1) {
        const val = await options.nth(1).getAttribute("value");
        if (val) await sel.selectOption(val);
      }
    }

    await submitBtn.first().click();
    console.log("Character creation submitted");

    // Wait for the response after character creation
    await waitForTurnStarted(page);
    await waitForTurnIdle(page);
    console.log("Character creation response received");

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-char-created.png",
    });

    // Verify we're still in a valid game session
    expect(page.url()).toMatch(/sid=/);
    await expectPlayerCanAct(page);
  });
});

test.describe("AI World Generator example prompts", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("example prompt chips populate the textarea without provider credentials", async ({
    page,
  }) => {
    await seedAppSettings(page);

    await page.goto("/session");
    const worldCards = page.locator("article").filter({
      has: page.locator("h2"),
    });
    await expect(worldCards.first()).toBeVisible({ timeout: 15_000 });

    const aiCreateBtn = page.locator("button", {
      hasText: /AI 创建世界|AI Create/i,
    });
    await expect(aiCreateBtn).toBeVisible();
    await aiCreateBtn.click();

    const dialog = page.locator("[role=dialog]");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Example prompt chips are local UI state and must not require a provider.
    const exampleChips = dialog.locator("button.text-xs");
    await expect(exampleChips.first()).toBeVisible({ timeout: 3_000 });
    expect(await exampleChips.count()).toBeGreaterThanOrEqual(1);

    await exampleChips.first().click();

    const promptTextarea = dialog.locator("#world-prompt");
    await expect(promptTextarea).not.toHaveValue("");

    // Selecting a prompt leaves the idle state, which hides the chips.
    await expect(exampleChips.first()).toBeHidden();
  });
});

// ── Helpers ──────────────────────────────────────────────────────

async function updatedWorldCount(page: Page): Promise<number> {
  return page
    .locator("article")
    .filter({ has: page.locator("h2") })
    .count();
}

function guessFieldValue(placeholder: string): string {
  const p = placeholder.toLowerCase();
  if (p.includes("name") || p.includes("名")) return "云行者";
  if (p.includes("class") || p.includes("职")) return "机械师";
  if (p.includes("race") || p.includes("种族")) return "人类";
  if (p.includes("age") || p.includes("年龄")) return "28";
  if (p.includes("background") || p.includes("背景")) return "飞艇工程师";
  if (p.includes("gender") || p.includes("性别")) return "女";
  if (p.includes("skill") || p.includes("技能")) return "机械改造";
  if (p.includes("origin") || p.includes("出身")) return "云端城";
  return "测试角色";
}
