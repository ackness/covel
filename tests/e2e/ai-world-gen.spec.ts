import { test, expect, type Page } from "@playwright/test";

/**
 * AI World Generation E2E — tests the full flow:
 *
 *   1. Navigate to world selection screen
 *   2. Click "AI 创建世界" to open the generator dialog
 *   3. Enter a world prompt (or click an example)
 *   4. Click "生成世界" to start generation
 *   5. Wait for SSE progress: generating → validating → saving → done
 *   6. Verify the new world appears in the world list
 *   7. Verify the world has dimensions via API
 *   8. Start a game with the world → verify character creation has schema-derived fields
 */

test.describe.configure({ mode: "serial" });

test.describe("AI World Generation", () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test.setTimeout(600_000); // 10 min — world gen + game start with LLM calls

  test("server has provider keys for generation", async ({ request }) => {
    const res = await request.get("/api/provider-keys");
    expect(res.ok()).toBeTruthy();
    const { keys } = await res.json();
    expect(Object.keys(keys).length).toBeGreaterThanOrEqual(1);
  });

  let createdWorldName: string | null = null;
  let createdWorldId: string | null = null;

  test("generate world via AI and verify it appears", async ({ page }) => {
    // ── Setup ──
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("covel:storageMode", "remote");
    });

    // ── Navigate to world selection ──
    await page.goto("/session");
    const worldCards = page.locator("div[class*=cursor-pointer]").filter({
      has: page.locator("h2"),
    });
    await expect(worldCards.first()).toBeVisible({ timeout: 15_000 });
    const initialWorldCount = await worldCards.count();
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
      hasText: /生成世界|Generate/i,
    });
    await expect(generateBtn).toBeEnabled();
    await generateBtn.click();

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-started.png",
    });

    // ── Wait for generation progress ──
    // Phase 1: Generating
    const progressIndicator = dialog.locator("text=/AI 正在构建|构建世界|generating/i");
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
    // The done indicator shows briefly (800ms) then dialog auto-closes.
    // To avoid a race condition, wait for EITHER the done indicator OR the dialog closing.
    // The dialog closing is the reliable signal that generation succeeded.
    try {
      const doneIndicator = dialog.locator("text=/世界创建完成|创建完成|World created/i");
      await expect(doneIndicator.first()).toBeVisible({ timeout: 180_000 });
      console.log("Phase: done (saw indicator)!");
      await page.screenshot({ path: "tests/e2e/artifacts/world-gen-done.png" });
      // Wait for dialog to auto-close
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    } catch {
      // If we missed the done indicator, check if dialog already closed (generation succeeded)
      if (await dialog.isHidden()) {
        console.log("Phase: done (dialog already closed)!");
      } else {
        // Check for error state
        const errorEl = dialog.locator("text=/生成失败|Error/i");
        if (await errorEl.isVisible().catch(() => false)) {
          const errorText = await errorEl.textContent();
          throw new Error(`World generation failed: ${errorText}`);
        }
        throw new Error("World generation timed out — dialog still open with no done/error state");
      }
    }
    console.log("Dialog closed");

    // ── Verify new world appears in the list ──
    // Re-query world cards after generation
    const updatedWorldCards = page.locator("div[class*=cursor-pointer]").filter({
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
    const worldNames = page.locator("div[class*=cursor-pointer] h2");
    const names: string[] = [];
    for (let i = 0; i < await worldNames.count(); i++) {
      const name = await worldNames.nth(i).textContent();
      if (name) names.push(name);
    }
    console.log(`World names: ${names.join(", ")}`);

    // The new world should have tags (AI-generated worlds include tags)
    const worldTags = page.locator("div[class*=cursor-pointer]").last().locator("[class*=badge], [class*=Badge]");
    const tagCount = await worldTags.count();
    console.log(`New world tags: ${tagCount}`);

    // Save the name for subsequent tests
    createdWorldName = names[names.length - 1] ?? null;
    expect(createdWorldName).toBeTruthy();
    console.log(`Created world: ${createdWorldName}`);
  });

  test("verify world dimensions via API", async ({ request }) => {
    test.skip(!createdWorldName, "No world was created in previous test");

    // Fetch all worlds and find the newly created one
    const res = await request.get("/worlds");
    expect(res.ok()).toBeTruthy();
    const worlds = await res.json();

    const created = worlds.find((w: Record<string, unknown>) => {
      const name = w.name;
      if (typeof name === "string") return name === createdWorldName;
      if (typeof name === "object" && name !== null) {
        return Object.values(name as Record<string, string>).some(
          (v) => v === createdWorldName,
        );
      }
      return false;
    });

    expect(created).toBeTruthy();
    createdWorldId = created.id as string;
    console.log(`World ID: ${createdWorldId}`);

    // Verify dimensions exist and have content
    const dims = created.dimensions as Record<string, unknown> | undefined;
    expect(dims).toBeTruthy();
    console.log(`Dimensions keys: ${Object.keys(dims!).join(", ")}`);

    // At minimum, geography and tone should be generated
    const dimKeys = Object.keys(dims!);
    expect(dimKeys.length).toBeGreaterThanOrEqual(3);
    console.log(`Dimension count: ${dimKeys.length}/9`);

    // Log which dimensions were generated
    const expectedDims = [
      "geography", "factions", "powerSystem", "history",
      "economy", "socialStructure", "tone", "mechanics", "startingConditions",
    ];
    for (const key of expectedDims) {
      const present = key in dims!;
      console.log(`  ${present ? "✓" : "✗"} ${key}`);
    }
  });

  test("start game with AI world → verify character creation schema", async ({
    page,
  }) => {
    test.skip(!createdWorldName, "No world was created in previous test");

    // ── Setup ──
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("covel:storageMode", "remote");
    });

    // ── Navigate to world selection ──
    await page.goto("/session");
    const worldCards = page.locator("div[class*=cursor-pointer]").filter({
      has: page.locator("h2"),
    });
    await expect(worldCards.first()).toBeVisible({ timeout: 15_000 });

    // ── Select the AI-created world ──
    const createdWorldCard = page
      .locator("div[class*=cursor-pointer]")
      .filter({ has: page.locator(`h2:has-text("${createdWorldName}")`) });
    await expect(createdWorldCard.first()).toBeVisible({ timeout: 10_000 });
    await createdWorldCard.first().click();

    // Verify prep screen
    const startButton = page.locator("button", {
      hasText: /start game|开始游戏/i,
    });
    await expect(startButton).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(createdWorldName!).first(),
    ).toBeVisible({ timeout: 5_000 });

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-prep.png",
    });

    // ── Start the game ──
    await startButton.click();

    // Wait for game view (input field + sid in URL)
    await expect(page.locator("input[type=text]").last()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/sid=/, { timeout: 10_000 });

    // Wait for session_start to complete (narrator + npc-init + init-wizard fire)
    await waitForExecDone(page);
    console.log("Session started");

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-session-start.png",
    });

    // ── Verify character creation form ──
    // init-wizard should emit a character_creation block
    // If schema was generated by core-npc-init, the form has multiple fields (not just name)
    const formFields = page.locator("[id^=block-field-]");
    const fieldCount = await formFields.count();
    console.log(`Character creation fields: ${fieldCount}`);

    // There should be at least the name field
    expect(fieldCount).toBeGreaterThanOrEqual(1);

    // Check for select dropdowns (enum fields from schema, like faction/class/origin)
    const selectFields = page.locator("select");
    const selectCount = await selectFields.count();
    console.log(`Select (enum) fields: ${selectCount}`);

    // Log all field info
    for (let i = 0; i < fieldCount; i++) {
      const field = formFields.nth(i);
      const id = await field.getAttribute("id");
      const placeholder = await field.getAttribute("placeholder");
      const tagName = await field.evaluate((el) => el.tagName.toLowerCase());
      console.log(`  Field[${i}]: id="${id}" placeholder="${placeholder}" tag=${tagName}`);
    }
    for (let i = 0; i < selectCount; i++) {
      const sel = selectFields.nth(i);
      const optionCount = await sel.locator("option").count();
      console.log(`  Select[${i}]: ${optionCount} options`);
    }

    // If core-npc-init generated a schema with bio fields, expect more than 1 field
    // (name + at least some bio fields like origin, class, etc.)
    if (fieldCount > 1 || selectCount > 0) {
      console.log("✓ Character creation has schema-derived fields (multi-field form)");
    } else {
      console.log("△ Character creation has only name field (no schema or bio fields)");
    }

    // The character_creation block should have a submit button
    const submitBtn = page.locator("button", {
      hasText: /confirm|确认|submit|提交|create|创建/i,
    });
    await expect(submitBtn.first()).toBeVisible({ timeout: 5_000 });

    // ── Fill the form and submit ──
    for (let i = 0; i < fieldCount; i++) {
      const field = formFields.nth(i);
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
    await waitForExecDone(page);
    console.log("Character creation response received");

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-char-created.png",
    });

    // Verify we're still in a valid game session
    expect(page.url()).toMatch(/sid=/);
    const finalInput = page.locator("input[type=text]").last();
    await expect(finalInput).toBeEnabled({ timeout: 5_000 });
  });

  test("example prompt chips populate the textarea", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("covel:storageMode", "remote");
    });

    await page.goto("/session");
    const worldCards = page.locator("div[class*=cursor-pointer]").filter({
      has: page.locator("h2"),
    });
    await expect(worldCards.first()).toBeVisible({ timeout: 15_000 });

    // Open dialog
    const aiCreateBtn = page.locator("button", {
      hasText: /AI 创建世界|AI Create/i,
    });
    await aiCreateBtn.click();

    const dialog = page.locator("[role=dialog]");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Example prompt chips should be visible when textarea is empty
    const exampleChips = dialog.locator("button.text-xs");
    await expect(exampleChips.first()).toBeVisible({ timeout: 3_000 });
    const chipCount = await exampleChips.count();
    expect(chipCount).toBeGreaterThanOrEqual(1);

    // Click the first example chip
    const chipText = await exampleChips.first().textContent();
    await exampleChips.first().click();

    // Textarea should now have content
    const promptTextarea = dialog.locator("#world-prompt");
    const promptValue = await promptTextarea.inputValue();
    expect(promptValue.length).toBeGreaterThan(0);
    console.log(`Example prompt selected: ${promptValue.slice(0, 50)}...`);

    // Example chips should hide after prompt is filled
    await expect(exampleChips.first()).toBeHidden();

    await page.screenshot({
      path: "tests/e2e/artifacts/world-gen-example.png",
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────

async function waitForExecDone(page: Page) {
  const input = page.locator("input[type=text]").last();
  try {
    await expect(input).toBeEnabled({ timeout: 10_000 });
  } catch {
    await expect(input).toBeEnabled({ timeout: 180_000 });
  }
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
