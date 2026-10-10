import type { DataStore } from "@covel/store";

/**
 * When the newest foreground turn began. A player's answer is "followed up"
 * once a turn has started after it was stored: the follow-up action ran (or
 * failed and is retryable from that turn). Derived from the trace journal, so
 * no extra record is kept.
 */
export async function latestTurnStartedAt(
  store: Pick<DataStore, "queryTraceEvents">,
  sessionId: string,
): Promise<string | undefined> {
  const [started] = await store.queryTraceEvents(sessionId, {
    types: ["turn.started"],
    newestFirst: true,
    limit: 1,
  });
  return started?.createdAt;
}

export function answerWasFollowedUp(
  answeredAt: string,
  latestTurnStarted: string | undefined,
): boolean {
  return (
    latestTurnStarted !== undefined &&
    Date.parse(latestTurnStarted) > Date.parse(answeredAt)
  );
}
