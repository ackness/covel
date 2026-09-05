import { expect, test, type Page } from "@playwright/test";
import type { SessionExecutionStatus, SnapshotTraceEvent } from "@covel/shared";
import { composer } from "./helpers/player.js";
import {
  createRecoveryFixture,
  latestTurnId,
  recoveredStory,
  trackerRuntimeId,
} from "./execution-recovery-fixtures.js";

test.use({ viewport: { width: 1280, height: 900 } });

const secondRuntimeId = "core-quest";
const failedRuntimeIds = [trackerRuntimeId, secondRuntimeId].sort();
const batchTurnId = "e2e-batch-retry-attempt";
const singleTurnId = "e2e-single-retry-attempt";
type Phase =
  "initial" | "batch-running" | "partial" | "single-running" | "complete";

function event(
  turnId: string,
  type: string,
  second: number,
  payload: Record<string, unknown>,
): SnapshotTraceEvent {
  return {
    turnId,
    type,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, second)).toISOString(),
    payload: {
      ...(turnId !== latestTurnId ? { sourceTurnId: latestTurnId } : {}),
      ...payload,
    },
  };
}

function steps(
  phase: Phase,
  requests: { batch: string; single: string },
): SnapshotTraceEvent[] {
  const runtime = (
    turnId: string,
    runtimeId: string,
    pluginId: string,
    status: "started" | "completed" | "failed",
    second: number,
  ) =>
    event(turnId, `runtime.${status}`, second, {
      runtimeId,
      pluginId,
      ...(status === "failed"
        ? { error: `${runtimeId} output did not match output.schema` }
        : {}),
    });
  const base = [
    event(latestTurnId, "turn.started", 0, { requestId: "e2e-source-request" }),
    runtime(latestTurnId, "narrator", "narrator", "started", 0),
    runtime(latestTurnId, "narrator", "narrator", "completed", 3),
    runtime(latestTurnId, "guide", "guide", "completed", 4),
    runtime(latestTurnId, trackerRuntimeId, "npc-graph", "failed", 5),
    runtime(latestTurnId, secondRuntimeId, "core-quest", "failed", 6),
    event(latestTurnId, "turn.completed", 7, { committed: true }),
  ];
  if (phase === "initial") return base;
  base.push(
    event(batchTurnId, "turn.started", 10, {
      requestId: requests.batch,
      recoveryAction: {
        type: "retry_failed_runtimes",
        payload: {
          retryFromTurnId: latestTurnId,
          runtimeIds: failedRuntimeIds,
        },
      },
    }),
    runtime(batchTurnId, trackerRuntimeId, "npc-graph", "started", 11),
    runtime(batchTurnId, secondRuntimeId, "core-quest", "started", 12),
  );
  if (phase === "batch-running") return base;
  base.push(
    runtime(batchTurnId, trackerRuntimeId, "npc-graph", "completed", 13),
    runtime(batchTurnId, secondRuntimeId, "core-quest", "failed", 14),
    event(batchTurnId, "turn.completed", 15, { committed: true }),
  );
  if (phase === "partial") return base;
  base.push(
    event(singleTurnId, "turn.started", 20, {
      requestId: requests.single,
      recoveryAction: {
        type: "retry_runtime",
        payload: { retryFromTurnId: latestTurnId, runtimeId: secondRuntimeId },
      },
    }),
    runtime(singleTurnId, secondRuntimeId, "core-quest", "started", 21),
  );
  if (phase === "complete")
    base.push(
      runtime(singleTurnId, secondRuntimeId, "core-quest", "completed", 22),
      event(singleTurnId, "turn.completed", 23, { committed: true }),
    );
  return base;
}

async function createBatchFixture(page: Page) {
  let phase: Phase = "initial";
  const requests = { batch: "e2e-batch-request", single: "e2e-single-request" };
  const execution = (): SessionExecutionStatus => ({
    state: phase.endsWith("running") ? "running" : "completed",
    turnId:
      phase === "initial"
        ? latestTurnId
        : phase.startsWith("single") || phase === "complete"
          ? singleTurnId
          : batchTurnId,
    requestId:
      phase === "initial"
        ? "e2e-source-request"
        : phase.startsWith("single") || phase === "complete"
          ? requests.single
          : requests.batch,
    startedAt: new Date(
      Date.UTC(
        2026,
        0,
        1,
        0,
        1,
        phase === "initial"
          ? 0
          : phase.startsWith("single") || phase === "complete"
            ? 20
            : 10,
      ),
    ).toISOString(),
    origin: "player",
  });
  const fixture = await createRecoveryFixture(page, "completed", true, {
    execution,
    steps: () => steps(phase, requests),
    onAction: (action) => {
      if (action.type === "retry_failed_runtimes") {
        requests.batch = action.requestId;
        phase = "batch-running";
      }
      if (action.type === "retry_runtime") {
        requests.single = action.requestId;
        phase = "single-running";
      }
    },
  });
  return {
    fixture,
    finishBatch() {
      phase = "partial";
    },
    finishSingle() {
      phase = "complete";
    },
  };
}

test("batch retry survives refresh, retains only its failed task and clears resolved errors", async ({
  page,
}) => {
  const { fixture, finishBatch, finishSingle } = await createBatchFixture(page);
  try {
    await page.goto(`/session?sid=${fixture.id}`);
    const current = page.locator(
      `[data-row-kind="execution"][data-turn-id="${latestTurnId}"]`,
    );
    const alerts = current.getByRole("alert");
    const story = page.locator(".ui-narrative");
    await expect(story).toContainText(recoveredStory);
    await expect(alerts).toHaveCount(2);
    const batch = current.getByRole("button", { name: /重试失败任务.*2/ });
    await expect(batch).toBeVisible();
    await batch.click();
    await expect.poll(() => fixture.actions.length).toBe(1);
    expect(fixture.actions[0]).toMatchObject({
      type: "retry_failed_runtimes",
      sessionId: fixture.id,
      payload: {
        retryFromTurnId: latestTurnId,
        runtimeIds: failedRuntimeIds,
      },
    });
    await page.reload();
    await expect(page.getByTestId("execution-recovery-notice")).toContainText(
      "上一回合仍在执行",
    );
    await expect(composer(page)).toHaveAttribute("data-executing", "true");
    const observations = fixture.executionReads;
    await expect
      .poll(() => fixture.executionReads, { timeout: 10_000 })
      .toBeGreaterThan(observations);
    expect(fixture.actions).toHaveLength(1);
    await expect(story).toContainText(recoveredStory);
    await expect(current.locator(".animate-spin").first()).toBeVisible();

    finishBatch();
    await expect(alerts).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("execution-recovery-notice")).toHaveCount(0);
    await expect(alerts).toContainText("任务日志");
    await expect(page.locator('[data-row-kind="execution"]')).toHaveCount(1);
    const retry = alerts.getByRole("button", { name: /重试此任务/ });
    await expect(retry).toBeVisible();
    expect(fixture.actions).toHaveLength(1);
    await retry.click();
    await expect.poll(() => fixture.actions.length).toBe(2);
    expect(fixture.actions[1]).toMatchObject({
      type: "retry_runtime",
      sessionId: fixture.id,
      payload: { runtimeId: secondRuntimeId, retryFromTurnId: latestTurnId },
    });
    // The action transport has requested neither the already-successful guide nor narrator.
    expect(
      fixture.actions.map(
        (action) => action.payload.runtimeIds ?? [action.payload.runtimeId],
      ),
    ).toEqual([failedRuntimeIds, [secondRuntimeId]]);
    finishSingle();
    await expect(current.getByRole("alert")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("execution-recovery-notice")).toHaveCount(0);
    await expect(composer(page)).toHaveAttribute("data-executing", "false");
    await expect(story).toContainText(recoveredStory);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(fixture.actions).toHaveLength(2);
  } finally {
    await fixture.dispose();
  }
});
