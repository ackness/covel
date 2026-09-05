import { test, expect, type Page } from "@playwright/test";
import {
  seedAppSettings,
  selectWorldByText,
  useServerWorlds,
} from "./helpers/player.js";

/**
 * Stage view mode smoke — no LLM turn.
 *
 * The interactive e2e infra is real-LLM-gated (see game-session.spec), so per
 * the stage-mode plan this covers the viewMode plumbing without running a turn:
 *   1. haruka's world `defaultViewMode: stage` lands the game view in stage mode
 *   2. the header toggle switches between parsed and stage
 * Full stage-render visual regression (backdrop / sprites / typewriter over real
 * scene art) needs a committed turn and is verified manually.
 */

test.describe.configure({ mode: "serial" });

test.describe("Stage view mode", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await seedAppSettings(page);
    await useServerWorlds(page);
  });

  test("haruka defaultViewMode:stage applies and the toggle switches", async ({
    page,
  }) => {
    const sessionId = await enterFreshHarukaSession(page);

    try {
      const stageToggle = page.getByRole("button", {
        name: /舞台视图|Stage view/i,
      });
      const parsedToggle = page.getByRole("button", {
        name: /解析视图|Parsed view/i,
      });

      // world.yaml `defaultViewMode: stage` → stage is the initial mode on mount.
      await expect(stageToggle).toBeVisible({ timeout: 10_000 });
      await expect(stageToggle).toHaveAttribute("data-state", "on");

      // Toggle plumbing: parsed ↔ stage.
      await parsedToggle.click();
      await expect(stageToggle).toHaveAttribute("data-state", "off");
      await expect(parsedToggle).toHaveAttribute("data-state", "on");

      await stageToggle.click();
      await expect(stageToggle).toHaveAttribute("data-state", "on");

      await page.screenshot({ path: "debugs/e2e-logs/stage-toggle.png" });
    } finally {
      const cleanup = await page.request.delete(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      expect(cleanup.ok(), "stage test session cleanup failed").toBeTruthy();
    }
  });

  test("mobile restored decisions remain bounded, scrollable, and actionable", async ({
    page,
  }) => {
    const sessionId = await enterFreshHarukaSession(page);
    const sessionPath = `**/api/sessions/${sessionId}`;
    const lastChoice =
      "Walk to the library and ask the librarian about the old festival journal.";
    try {
      // Restore a deterministic completed turn without invoking a model.
      await page.route(sessionPath, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch();
        const session = (await response.json()) as Record<string, unknown>;
        await route.fulfill({
          response,
          json: { ...session, phase: "playing" },
        });
      });
      await page.route(`${sessionPath}/view`, async (route) => {
        const response = await route.fetch();
        const snapshot = (await response.json()) as {
          session: Record<string, unknown>;
        };
        await route.fulfill({
          response,
          json: {
            ...snapshot,
            session: { ...snapshot.session, phase: "playing" },
            messages: [
              {
                id: "stage-mobile-story",
                role: "assistant",
                kind: "story",
                turnId: "stage-mobile-turn",
                content:
                  "Mio points toward the library.\n\nThe afternoon bell rings.",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        });
      });
      await page.route(
        `${sessionPath}/plugin-data/scene-prompts{,/**}`,
        async (route) => {
          const prompts = {
            __turnId: "stage-mobile-turn",
            scene: "After class",
            recap:
              "Mio has offered to help you find an old festival journal. ".repeat(
                30,
              ),
            decision: "Where will you look first?",
            ...Object.fromEntries(
              Array.from({ length: 5 }, (_, index) => [
                `prompt${index + 1}Text`,
                `Option ${index + 1}: Ask about the archive, then compare the notes with the festival records.`,
              ]),
            ),
            prompt6Text: lastChoice,
          };
          await route.fulfill({
            json: {
              items: Object.entries(prompts).map(([key, value]) => ({
                namespace: "message",
                key,
                value,
                updatedAt: "2026-01-01T00:00:00Z",
              })),
            },
          });
        },
      );
      await page.route("**/api/actions", async (route) => {
        await route.fulfill({ contentType: "text/event-stream", body: "" });
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      const stage = page.getByTestId("stage-view");
      const panel = page.getByTestId("stage-choices");
      const input = page.getByTestId("stage-decision-input");
      await expect(panel).toBeVisible();
      await expect(panel.getByText("Where will you look first?")).toBeVisible();
      const stageBox = await stage.boundingBox();
      const panelBox = await panel.boundingBox();
      expect(stageBox).not.toBeNull();
      expect(panelBox).not.toBeNull();
      expect(panelBox!.height).toBeLessThanOrEqual(stageBox!.height * 0.61);
      expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(
        stageBox!.y + stageBox!.height + 1,
      );
      await expect(input).toBeInViewport();
      await panel.locator("summary").click();
      await expect(panel.locator("details")).toHaveAttribute("open", "");
      await expect(input).toBeInViewport();
      await input.fill("I check the journal.");
      await expect(input).toHaveValue("I check the journal.");

      const actionRequest = page.waitForRequest(
        (request) =>
          request.url().endsWith("/api/actions") && request.method() === "POST",
      );
      await panel
        .getByRole("button", { name: lastChoice, exact: true })
        .click();
      expect((await actionRequest).postDataJSON()).toMatchObject({
        sessionId,
        type: "send_message",
        payload: { content: lastChoice },
      });
    } finally {
      // Finish pending restore requests before deleting their session or context.
      await page.unrouteAll({ behavior: "wait" });
      const cleanup = await page.request.delete(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      expect(
        cleanup.ok(),
        "stage mobile test session cleanup failed",
      ).toBeTruthy();
    }
  });
});

async function enterFreshHarukaSession(page: Page): Promise<string> {
  await page.goto("/session");

  await selectWorldByText(
    page,
    /遥风学园・春日薄荷|Haruka Academy · Spring Mint/i,
  );

  const startButton = page
    .getByRole("button", { name: /^(start game|开始游戏)$/i })
    .first();
  await expect(startButton).toBeVisible({ timeout: 10_000 });
  await startButton.click();

  await expect(page).toHaveURL(/sid=/, { timeout: 15_000 });
  const sessionId = new URL(page.url()).searchParams.get("sid");
  expect(sessionId).toBeTruthy();
  return sessionId!;
}
