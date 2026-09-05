import { expect, test } from "@playwright/test";
import { composer, composerInput } from "./helpers/player.js";
import {
  createRecoveryFixture,
  latestTurnId,
  recoveredStory,
  sourceTurnId,
  trackerRuntimeId,
} from "./execution-recovery-fixtures.js";

test.use({ viewport: { width: 1280, height: 900 } });
const originalRequestId = "e2e-original-request";
const playerAction = "Ask the archivist to examine the sealed notebook.";

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

test("older orphaned execution stays before the latest story while an optional task can be retried", async ({
  page,
}) => {
  const fixture = await createRecoveryFixture(page, "completed", true);
  try {
    await page.goto(`/session?sid=${fixture.id}`);
    const historical = page.locator(
      `[data-row-kind="execution"][data-turn-id="${sourceTurnId}"]`,
    );
    const current = page.locator(
      `[data-row-kind="execution"][data-turn-id="${latestTurnId}"]`,
    );
    await expect(page.locator(".ui-narrative")).toContainText(recoveredStory);
    await expect(page.getByTestId("execution-recovery-notice")).toHaveCount(0);
    await expect(historical).toHaveAttribute("data-turn-current", "false");
    await expect(current).toHaveAttribute("data-turn-current", "true");
    const fold = historical.getByRole("button").first();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(historical.getByRole("alert")).toBeHidden();
    expect(
      await historical.evaluate((element) => {
        const story = document.querySelector(".ui-narrative");
        return (
          !!story &&
          !!(
            element.compareDocumentPosition(story) &
            Node.DOCUMENT_POSITION_FOLLOWING
          )
        );
      }),
    ).toBe(true);
    await fold.click();
    await expect(historical.getByRole("button", { name: /重试/ })).toHaveCount(
      0,
    );
    await fold.click();

    await expect(current.getByRole("alert")).toContainText("未产出有效结果");
    const retry = current.getByRole("button", {
      name: /重试此任务/,
    });
    await expect(retry).toBeVisible();
    await expect(retry).toHaveText("重试此任务");
    expect(fixture.actions).toEqual([]);
    await retry.click();
    await expect.poll(() => fixture.actions.length).toBe(1);
    expect(fixture.actions[0]).toMatchObject({
      sessionId: fixture.id,
      type: "retry_runtime",
      payload: { runtimeId: trackerRuntimeId, retryFromTurnId: latestTurnId },
    });
    expect(fixture.actions[0]!.payload).not.toHaveProperty("recoverFromTurnId");
    await expect(page.locator(".ui-narrative")).toContainText(recoveredStory);
    expect(fixture.actions).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
});

test("a new running turn keeps historical interruption folded and shows its own progress", async ({
  page,
}) => {
  const fixture = await createRecoveryFixture(page, "running", true);
  try {
    await page.goto(`/session?sid=${fixture.id}`);
    await page.reload();
    const historical = page.locator(
      `[data-row-kind="execution"][data-turn-id="${sourceTurnId}"]`,
    );
    const current = page.locator(
      `[data-row-kind="execution"][data-turn-id="${latestTurnId}"]`,
    );
    const notice = page.getByTestId("execution-recovery-notice");
    await expect(notice).toContainText("上一回合仍在执行");
    await expect(notice).not.toContainText("此回合已中断");
    await expect(notice.getByRole("button", { name: /重试/ })).toHaveCount(0);
    await expect(historical).toHaveAttribute("data-turn-current", "false");
    await expect(historical.getByRole("button").first()).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(historical.getByRole("alert")).toBeHidden();
    await expect(historical.getByRole("button", { name: /重试/ })).toHaveCount(
      0,
    );
    await expect(current).toHaveAttribute("data-turn-current", "true");
    await expect(current.getByRole("button").first()).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(current.locator(".animate-spin").first()).toBeVisible();
    await expect(composer(page)).toHaveAttribute("data-executing", "true");
    expect(fixture.actions).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});
