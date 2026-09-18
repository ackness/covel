import { expect, test } from "@playwright/test";
import type { SnapshotTraceEvent } from "@covel/shared";
import {
  createRecoveryFixture,
  sourceTurnId,
  recoveredStory,
} from "./execution-recovery-fixtures.js";

for (const width of [1280, 390]) {
  test(`thinking stays collapsed and separate from the story after recovery (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const trace = (
      type: string,
      runtimeId: string,
      seq: number,
      reasoningContent?: string,
    ): SnapshotTraceEvent => ({
      type,
      turnId: sourceTurnId,
      timestamp: "2026-01-01T00:00:02Z",
      payload: {
        runtimeId,
        pluginId: runtimeId.split("/")[0],
        flowId: "fixture-flow",
        seq,
        ...(reasoningContent ? { reasoningContent } : {}),
        status: "success",
      },
    });
    const thought = "Check the map before advancing the story.";
    const pluginThought = "Compare the notebook with stored clues.";
    const fixture = await createRecoveryFixture(page, "completed", false, {
      execution: () => ({ state: "completed", turnId: sourceTurnId }),
      steps: () => [
        trace("llm.responded", "narrator/main", 1, thought),
        trace("llm.responded", "narrator/main", 1, thought),
        trace("runtime.completed", "narrator/main", 2),
        trace("gateway.responded", "codex/extract", 3, pluginThought),
        trace("runtime.completed", "codex/extract", 4),
      ],
    });
    try {
      await page.goto(`/session?sid=${fixture.id}`);
      const disclosure = page.getByTestId("reasoning-disclosure");
      await expect(disclosure).toHaveCount(1);
      await expect(disclosure).not.toHaveAttribute("open");
      await expect(disclosure.locator("summary")).toContainText("思考内容 · 2");
      await expect(page.locator(".ui-narrative")).toContainText(recoveredStory);
      await expect(page.locator(".ui-narrative")).not.toContainText(thought);
      await disclosure.locator("summary").click();
      await expect(disclosure).toHaveAttribute("open", "");
      await expect(
        disclosure.getByText(thought, { exact: true }),
      ).toBeVisible();
      await expect(
        disclosure.getByText(pluginThought, { exact: true }),
      ).toBeVisible();
      await expect(disclosure).toContainText("narrator/main");
      await expect(disclosure).toContainText("codex/extract");
      expect(
        await disclosure.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      ).toBe(true);
      await page.reload();
      await expect(disclosure).not.toHaveAttribute("open");
      await expect(disclosure.locator("summary")).toContainText("思考内容 · 2");
      await page.getByRole("button", { name: "舞台视图", exact: true }).click();
      await page.getByRole("button", { name: "履历", exact: true }).click();
      const history = page.getByRole("dialog", { name: "对话履历" });
      const historyReasoning = history.getByTestId("reasoning-disclosure");
      await expect(historyReasoning).not.toHaveAttribute("open");
      await historyReasoning.locator("summary").click();
      await expect(
        historyReasoning.getByText(thought, { exact: true }),
      ).toBeVisible();
      await expect(history.locator('[data-row-kind="execution"]')).toHaveCount(
        0,
      );
      expect(fixture.actions).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
}
