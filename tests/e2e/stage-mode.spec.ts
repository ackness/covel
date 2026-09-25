import { readFileSync } from "node:fs";
import type { SessionPlugin } from "@covel/shared";
import { test, expect, type Page, type Route } from "@playwright/test";
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

  test("mobile restored third-party retry decisions remain bounded and actionable", async ({
    page,
  }) => {
    const sessionId = await enterFreshHarukaSession(page);
    const sessionPath = `**/api/sessions/${sessionId}`;
    const lastChoice =
      "Walk to the library and ask the librarian about the old festival journal.";
    try {
      // Capture the restore baseline once. Fetching inside route handlers races
      // with route removal after the mocked action triggers another restore.
      const apiPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
      const [sessionResponse, viewResponse, pluginsResponse] =
        await Promise.all([
          page.request.get(apiPath),
          page.request.get(`${apiPath}/view`),
          page.request.get(`${apiPath}/plugins`),
        ]);
      for (const response of [sessionResponse, viewResponse, pluginsResponse]) {
        expect(
          response.ok(),
          "stage restore baseline unavailable",
        ).toBeTruthy();
      }
      const session = (await sessionResponse.json()) as Record<string, unknown>;
      const snapshot = (await viewResponse.json()) as {
        session: Record<string, unknown>;
      };
      const directory = await pluginsResponse.json();
      // ZIP installation and execution are exercised by the server integration
      // test. This browser fixture checks capability discovery and legacy stamps
      // with that package's ID, without depending on a live provider.
      await page.route(`${sessionPath}/plugins`, async (route) => {
        await route.fulfill({
          json: {
            ...directory,
            items: directory.items.map(
              (item: { id: string; capabilities?: string[] }) =>
                item.capabilities?.includes("scene-prompts")
                  ? { ...item, id: "lifecycle-probe" }
                  : item,
            ),
          },
        });
      });
      // Restore a deterministic completed turn without invoking a model.
      await page.route(sessionPath, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
          json: { ...session, phase: "playing" },
        });
      });
      await page.route(`${sessionPath}/view`, async (route) => {
        await route.fulfill({
          json: {
            ...snapshot,
            session: { ...snapshot.session, phase: "playing" },
            executionSteps: [
              {
                type: "turn.started",
                turnId: "stage-mobile-retry",
                timestamp: "2026-01-01T00:01:00Z",
                payload: {
                  sourceTurnId: "stage-mobile-turn",
                  runtimeIds: ["lifecycle-probe/cards"],
                  sourceCommitted: true,
                  sourceFailedRuntimeIds: ["lifecycle-probe/cards"],
                },
              },
              {
                type: "runtime.completed",
                turnId: "stage-mobile-retry",
                timestamp: "2026-01-01T00:01:01Z",
                payload: {
                  runtimeId: "lifecycle-probe/cards",
                  pluginId: "lifecycle-probe",
                  status: "success",
                },
              },
              {
                type: "turn.completed",
                turnId: "stage-mobile-retry",
                timestamp: "2026-01-01T00:01:02Z",
                payload: {
                  committed: true,
                  sourceTurnId: "stage-mobile-turn",
                  runtimeIds: ["lifecycle-probe/cards"],
                  sourceCommitted: true,
                  sourceFailedRuntimeIds: [],
                },
              },
            ],
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
        `${sessionPath}/plugin-data/lifecycle-probe{,/**}`,
        async (route) => {
          const prompts = {
            __turnId: "stage-mobile-retry",
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
      // Stop the live UI before removing fixtures and deleting its session.
      await page.goto("about:blank");
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
  test("plugin-owned stage UI hides during submission and rejects stale results", async ({
    page,
  }) => {
    const sessionId = await enterFreshHarukaSession(page);
    const apiPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const mask = `**${apiPath}`;
    const [session, snapshot, directory] = await Promise.all([
      page.request.get(apiPath).then((r) => r.json()),
      page.request.get(`${apiPath}/view`).then((r) => r.json()),
      page.request.get(`${apiPath}/plugins`).then((r) => r.json()),
    ]);
    let turnId = "demo-turn";
    const html = readFileSync(
      new URL("./test-assets/stage-recommendations.html", import.meta.url),
      "utf8",
    );
    try {
      await page.route(mask, (route) =>
        route.request().method() === "GET"
          ? route.fulfill({
              json: {
                ...session,
                phase: "playing",
                activePlugins: [
                  ...session.activePlugins,
                  "stage-evaluation-fixture",
                ],
              },
            })
          : route.fallback(),
      );
      await page.route(`${mask}/plugins`, (route) =>
        route.fulfill({
          json: {
            ...directory,
            items: [
              ...directory.items,
              {
                id: "stage-evaluation-fixture",
                displayName: "Evaluation Fixture",
                description: "Synthetic stage bridge consumer",
                pluginType: "plugin",
                active: true,
                locked: false,
                source: "community",
                status: "registered",
                runtimeCount: 0,
                runtimes: [],
                tools: [],
                userSettings: [],
                capabilities: [],
                tags: ["role:demo"],
              } satisfies SessionPlugin,
            ],
          },
        }),
      );
      await page.route(`${mask}/view`, (route) =>
        route.fulfill({
          json: {
            ...snapshot,
            session: {
              ...snapshot.session,
              phase: "playing",
            },
            messages: [
              {
                id: "demo-story",
                kind: "story",
                role: "assistant",
                turnId,
                content: "A friend offers a school tour.",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        }),
      );
      await page.route("**/api/ui-specs?**", (route) =>
        route.fulfill({
          json: {
            right: [
              {
                pluginId: "stage-evaluation-fixture",
                specs: [
                  {
                    id: "recommendations",
                    label: "Evaluation Fixture",
                    surfaces: ["stage"],
                    dataSource: { namespace: "recommendations" },
                    webview: { html, height: 300 },
                  },
                ],
              },
            ],
            message: [],
            left: [],
          },
        }),
      );
      await page.route(`${mask}/plugin-data/scene-prompts{,/**}`, (route) =>
        route.fulfill({
          json: {
            items: Object.entries({
              __turnId: "demo-turn",
              scene: "School tour",
              decision: "Where next?",
              prompt1Text: "Ask about the library",
              prompt2Text: "Explore the classroom",
            }).map(([key, value]) => ({
              namespace: "message",
              key,
              value,
              updatedAt: "2026-01-01T00:00:00Z",
            })),
          },
        }),
      );
      await page.route(
        `${mask}/plugin-data/stage-evaluation-fixture{,/**}`,
        (route) =>
          route.fulfill({
            json: {
              items: [
                {
                  namespace: "recommendations",
                  key: "current",
                  updatedAt: "2026-01-01T00:00:00Z",
                  value: {
                    turnId: "demo-turn",
                    status: "ready",
                    model: "fixture/jev",
                    selectedId: "prompt:2",
                    options: [
                      {
                        id: "prompt:1",
                        text: "Ask about the library",
                        probability: 0.25,
                      },
                      {
                        id: "prompt:2",
                        text: "Explore the classroom",
                        probability: 0.75,
                      },
                    ],
                  },
                },
              ],
            },
          }),
      );
      await page.reload();
      const host = page.getByTestId("stage-plugin-panels");
      await expect(host).toBeVisible();
      const frame = host.frameLocator("iframe");
      await expect(frame.getByText("75%", { exact: true })).toBeVisible();
      await expect(frame.getByText("25%", { exact: true })).toBeVisible();
      await expect(host.locator("iframe")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      );
      const content = await host.locator("iframe").elementHandle();
      const child = await content!.contentFrame();
      expect(
        await child!.evaluate(() => {
          try {
            void parent.document.body;
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
      expect(
        await child!.evaluate(async () => {
          const bridge = (
            window as unknown as {
              covel: { invoke(action: string): Promise<unknown> };
            }
          ).covel;
          try {
            await bridge.invoke("arbitraryHostFunction");
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
      await page.screenshot({ path: "debugs/e2e-logs/plugin-stage.png" });

      const action = Promise.withResolvers<Route>();
      await page.route("**/api/actions", (route) => action.resolve(route));
      const panel = page.getByTestId("stage-choices");
      await panel
        .getByRole("button", { name: "Explore the classroom", exact: true })
        .click();
      const pending = await action.promise;
      // No response or new narration yet: hide the whole previous decision,
      // including plugin-owned HTML, without replaying the already-read story.
      await expect(panel).toHaveCount(0);
      await expect(host).toHaveCount(0);
      await expect(page.getByTestId("stage-dialog")).toHaveCount(0);
      await expect(page.getByTestId("stage-thinking")).toBeVisible();
      await pending.fulfill({ contentType: "text/event-stream", body: "" });
      await expect(panel).toBeVisible();

      turnId = "new-turn";
      await page.reload();
      await expect(frame.getByText("75%", { exact: true })).toHaveCount(0);
      await expect(frame.locator("#status")).toContainText(/等待|Waiting/);
    } finally {
      await page.goto("about:blank");
      await page.unrouteAll({ behavior: "wait" });
      expect((await page.request.delete(apiPath)).ok()).toBeTruthy();
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
