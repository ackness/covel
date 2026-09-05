import { expect, type Page } from "@playwright/test";
import type { SessionExecutionStatus, SnapshotTraceEvent } from "@covel/shared";
import { seedAppSettings, useServerWorlds } from "./helpers/player.js";

export const sourceTurnId = "e2e-interrupted-turn";
export const latestTurnId = "e2e-current-turn";
export const trackerRuntimeId = "npc-graph/extractor";
const originalRequestId = "e2e-original-request";
const playerAction = "Ask the archivist to examine the sealed notebook.";
export const recoveredStory =
  "The archivist opens the notebook and finds the missing harbor map.";

export interface CapturedAction {
  requestId: string;
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

function historySteps(completed: boolean): SnapshotTraceEvent[] {
  const event = (
    turnId: string,
    type: string,
    timestamp: string,
    runtimeId: string,
    pluginId: string,
    error?: string,
  ): SnapshotTraceEvent => ({
    turnId,
    type,
    timestamp,
    payload: { runtimeId, pluginId, ...(error ? { error } : {}) },
  });
  return [
    event(
      sourceTurnId,
      "runtime.started",
      "2026-01-01T00:00:00Z",
      "narrator",
      "narrator",
    ),
    event(
      latestTurnId,
      "runtime.started",
      "2026-01-01T00:01:00Z",
      "narrator",
      "narrator",
    ),
    ...(completed
      ? [
          event(
            latestTurnId,
            "runtime.completed",
            "2026-01-01T00:01:03Z",
            "narrator",
            "narrator",
          ),
          event(
            latestTurnId,
            "runtime.started",
            "2026-01-01T00:01:04Z",
            trackerRuntimeId,
            "npc-graph",
          ),
          event(
            latestTurnId,
            "runtime.failed",
            "2026-01-01T00:01:05Z",
            trackerRuntimeId,
            "npc-graph",
            "npc-graph/extractor declares requireToolUse but finished without calling a business tool (a bare `runtime-done` does not count). The model answered with prose instead of doing the work.",
          ),
        ]
      : []),
  ];
}

/** Real isolated session, with only execution observations and action transport stubbed. */
export async function createRecoveryFixture(
  page: Page,
  initialState: "running" | "interrupted" | "completed",
  withHistory = false,
  observations?: {
    execution: () => SessionExecutionStatus;
    steps: () => SnapshotTraceEvent[];
    onAction?: (action: CapturedAction) => void;
  },
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
        "core-quest",
        "codex",
        "npc-graph",
        "living-world-rules",
        "character-blueprint",
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
  const session = (await response.json()) as { id: string };
  const [sessionResponse, snapshotResponse] = await Promise.all([
    page.request.get(`/api/sessions/${session.id}`),
    page.request.get(`/api/sessions/${session.id}/view`),
  ]);
  expect(sessionResponse.ok()).toBeTruthy();
  expect(snapshotResponse.ok()).toBeTruthy();
  const sessionRecord = await sessionResponse.json();
  const snapshot = await snapshotResponse.json();
  let executionState: SessionExecutionStatus["state"] = initialState;
  const currentTurnId = withHistory ? latestTurnId : sourceTurnId;
  const startedAt = withHistory
    ? "2026-01-01T00:01:00Z"
    : "2026-01-01T00:00:00Z";
  let executionReads = 0;
  const actions: CapturedAction[] = [];
  const status = (): SessionExecutionStatus =>
    observations?.execution() ?? {
      state: executionState,
      turnId: currentTurnId,
      requestId: originalRequestId,
      startedAt,
      origin: "player",
      ...(executionState === "interrupted"
        ? {
            retry: {
              type: "send_message" as const,
              payload: { content: playerAction },
            },
          }
        : {}),
    };
  const sessionPath = `**/api/sessions/${session.id}`;
  await page.route(sessionPath, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: { ...sessionRecord, phase: "playing" },
    });
  });
  await page.route(`${sessionPath}/execution`, async (route) => {
    executionReads += 1;
    await route.fulfill({ json: status() });
  });
  await page.route(`${sessionPath}/view`, async (route) => {
    await route.fulfill({
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
            turnId: currentTurnId,
            content: playerAction,
            createdAt: startedAt,
          },
          ...(executionState === "completed"
            ? [
                {
                  id: "e2e-recovery-story",
                  role: "assistant",
                  kind: "story",
                  turnId: currentTurnId,
                  content: recoveredStory,
                  createdAt: withHistory
                    ? "2026-01-01T00:01:03Z"
                    : "2026-01-01T00:00:03Z",
                },
              ]
            : []),
        ],
        executionSteps:
          observations?.steps() ??
          (withHistory ? historySteps(executionState === "completed") : []),
      },
    });
  });
  // No request in either test can reach a provider, including an accidental auto-retry.
  await page.route("**/api/actions", async (route) => {
    const action = route.request().postDataJSON() as CapturedAction;
    actions.push(action);
    observations?.onAction?.(action);
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
