/**
 * A request the action handler refuses as invalid. The HTTP layer answers it
 * with 400 and the message, instead of the 500 of a handler that threw.
 */
export class RpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcValidationError";
  }
}
