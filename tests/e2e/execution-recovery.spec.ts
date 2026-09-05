import { expect, test, type Page } from "@playwright/test";
import type { SessionExecutionStatus } from "@covel/shared";
import {
  composer,
  composerInput,
  seedAppSettings,
  useServerWorlds,
} from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

const sourceTurnId = "e2e-interrupted-turn";
const originalRequestId = "e2e-original-request";
const playerAction = "Ask the archivist to examine the sealed notebook.";
const recoveredStory =
  "The archivist opens the notebook and finds the missing harbor map.";

interface CapturedAction {
  requestId: string;
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

/** Real isolated session, with only execution observations and action transport stubbed. */
async function createRecoveryFixture(
  page: Page,
  initialState: "running" | "interrupted",
) {
  await seedAppSettings(page);
  await useServerWorlds(page);
  const response = await page.request.post("/api/sessions", {
    data: {
      worldId: "mistport",
      locale: "zh-CN",
      plugins: [
        "pregame",
        "world-init",
        "char-creator",
        "narrator",
        "guide",
        "codex",
        "npc-graph",
        "living-world-rules",
        "character-blueprint",
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
  const session = (await response.json()) as { id: string };
  let executionState: SessionExecutionStatus["state"] = initialState;
  let executionReads = 0;
  const actions: CapturedAction[] = [];
  const status = (): SessionExecutionStatus => ({
    state: executionState,
    turnId: sourceTurnId,
    requestId: originalRequestId,
    startedAt: "2026-01-01T00:00:00Z",
    origin: "player",
    ...(executionState === "interrupted"
      ? {
          retry: {
            type: "send_message" as const,
            payload: { content: playerAction },
          },
        }
      : {}),
  });
  const sessionPath = `**/api/sessions/${session.id}`;
  await page.route(sessionPath, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), phase: "playing" },
    });
  });
  await page.route(`${sessionPath}/execution`, async (route) => {
    executionReads += 1;
    await route.fulfill({ json: status() });
  });
  await page.route(`${sessionPath}/view`, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({
      response,
      json: {
        ...snapshot,
        session: {
          ...snapshot.session,
          phase: "playing",
          completedPlayerTurns: executionState === "completed" ? 1 : 0,
        },
        execution: status(),
        messages: [
          {
            id: "e2e-recovery-player",
            role: "user",
            turnId: sourceTurnId,
            content: playerAction,
            createdAt: "2026-01-01T00:00:00Z",
          },
          ...(executionState === "completed"
            ? [
                {
                  id: "e2e-recovery-story",
                  role: "assistant",
                  kind: "story",
                  turnId: sourceTurnId,
                  content: recoveredStory,
                  createdAt: "2026-01-01T00:00:03Z",
                },
              ]
            : []),
        ],
        executionSteps: [],
      },
    });
  });
  // No request in either test can reach a provider, including an accidental auto-retry.
  await page.route("**/api/actions", async (route) => {
    actions.push(route.request().postDataJSON() as CapturedAction);
    await route.fulfill({ contentType: "text/event-stream", body: "" });
  });
  return {
    id: session.id,
    actions,
    get executionReads() {
      return executionReads;
    },
    complete() {
      executionState = "completed";
    },
    async dispose() {
      await page.unrouteAll({ behavior: "wait" });
      expect(
        (await page.request.delete(`/api/sessions/${session.id}`)).ok(),
      ).toBeTruthy();
    },
  };
}

test("refresh waits for the existing running turn and restores its completed story", async ({
  page,
}) => {
  const fixture = await createRecoveryFixture(page, "running");
  try {
    await page.goto(`/session?sid=${fixture.id}`);
    const notice = page.getByTestId("execution-recovery-notice");
    await expect(notice).toContainText("上一回合仍在执行");
    await page.reload();
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toContainText("上一回合仍在执行");
    await expect(composer(page)).toHaveAttribute("data-executing", "true");
    await expect(
      notice.getByRole("button", { name: "重试未完成回合" }),
    ).toHaveCount(0);
    const observations = fixture.executionReads;
    await expect
      .poll(() => fixture.executionReads, { timeout: 10_000 })
      .toBeGreaterThan(observations);
    expect(fixture.actions).toEqual([]);

    fixture.complete();
    await expect(page.locator(".ui-narrative")).toContainText(recoveredStory, {
      timeout: 10_000,
    });
    await expect(notice).toHaveCount(0);
    await expect(composer(page)).toHaveAttribute("data-executing", "false");
    await expect(composerInput(page)).toBeEnabled();
    expect(fixture.actions).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("refreshing an interrupted turn only retries after explicit player confirmation", async ({
  page,
}) => {
  const fixture = await createRecoveryFixture(page, "interrupted");
  try {
    await page.goto(`/session?sid=${fixture.id}`);
    const notice = page.getByTestId("execution-recovery-notice");
    await expect(notice).toContainText("此回合已中断");
    await page.reload();
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText("只有点击重试，才会发起新的尝试");
    const observations = fixture.executionReads;
    await notice.getByRole("button", { name: "检查状态" }).click();
    await expect
      .poll(() => fixture.executionReads)
      .toBeGreaterThan(observations);
    const retry = notice.getByRole("button", { name: "重试未完成回合" });
    await expect(retry).toBeEnabled();
    expect(fixture.actions).toEqual([]);

    await retry.click();
    await expect.poll(() => fixture.actions.length).toBe(1);
    expect(fixture.actions[0]).toMatchObject({
      sessionId: fixture.id,
      type: "send_message",
      payload: { content: playerAction, recoverFromTurnId: sourceTurnId },
    });
    expect(fixture.actions[0]!.requestId).toBeTruthy();
    expect(fixture.actions[0]!.requestId).not.toBe(originalRequestId);
  } finally {
    await fixture.dispose();
  }
});
