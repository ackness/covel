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
