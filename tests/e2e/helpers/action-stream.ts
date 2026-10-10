/**
 * The body of a `POST /api/actions` response for a stubbed action: one SSE
 * envelope per event, in the shape the client validates.
 */
export function actionStreamBody(
  action: { requestId: string; sessionId: string },
  turnId: string,
  events: ReadonlyArray<readonly [type: string, payload: unknown]>,
): string {
  return events
    .map(
      ([type, payload], seq) =>
        `data: ${JSON.stringify({
          type,
          requestId: action.requestId,
          traceId: "e2e-trace",
          sessionId: action.sessionId,
          turnId,
          flowId: "e2e-trace",
          seq,
          timestamp: new Date().toISOString(),
          payload,
        })}\n\n`,
    )
    .join("");
}
