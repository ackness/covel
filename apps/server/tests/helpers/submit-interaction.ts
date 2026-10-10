/** One event of an action stream. */
export interface ActionStreamEvent {
  readonly type: string;
  readonly turnId: string;
  readonly payload: Record<string, unknown>;
}

export function readActionStream(text: string): ActionStreamEvent[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as ActionStreamEvent);
}

/** The body of a `submit_interaction` action that answers one form. */
export function formSubmissionAction(
  sessionId: string,
  target: { turnId: string; form: { interactionId?: unknown } },
  values: Record<string, unknown>,
) {
  return {
    requestId: crypto.randomUUID(),
    sessionId,
    type: "submit_interaction",
    payload: {
      turnId: target.turnId,
      submissions: [
        {
          interactionId: target.form.interactionId,
          type: "form",
          values,
        },
      ],
    },
  };
}

/**
 * The outcome of a `submit_interaction` request as one status, for a test
 * that asserts the outcome and not the stream. A JSON answer sent before the
 * stream opens (an approval request, a guard's refusal) is returned as it is.
 * A stream is read to its end, so the follow-up turn has run: it becomes 400
 * with the `error.occurred` payload when the answer was refused, and 200 with
 * `{ events }` otherwise.
 */
export async function settledSubmission(response: Response): Promise<Response> {
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    return response;
  const events = readActionStream(await response.text());
  const refused = events.find((event) => event.type === "error.occurred");
  return Response.json(refused ? refused.payload : { events }, {
    status: refused ? 400 : 200,
  });
}
