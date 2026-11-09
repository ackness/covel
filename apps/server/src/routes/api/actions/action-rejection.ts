import type { ApiErrorResponse } from "../../../api-error.js";

/**
 * An expected refusal of an action after its SSE response opened: the
 * session changed, the retry target is stale, the input was already saved.
 * The stream reports it as `error.occurred` with its message and code in every
 * environment; nothing of the action was stored.
 */
export class ActionRejectedError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "ActionRejectedError";
  }
}

/** A guard's JSON refusal, for a stream that is already open; keeps its code. */
export async function entryRejection(
  response: Response,
): Promise<ActionRejectedError> {
  const body = (await response.json()) as Partial<ApiErrorResponse>;
  return typeof body.error === "string"
    ? new ActionRejectedError(body.error, body.code)
    : new ActionRejectedError(
        "Plugin approval is required",
        "approval_required",
      );
}
