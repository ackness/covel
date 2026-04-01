export type CommandErrorCode =
  | "INVALID_COMMAND_INPUT"
  | "DUPLICATE_COMMAND"
  | "COMMAND_NOT_FOUND"
  | "ARGUMENT_VALIDATION_FAILED";

export interface CommandIssue {
  path: string;
  message: string;
}

export interface CommandErrorOptions {
  code: CommandErrorCode;
  message: string;
  details?: Record<string, unknown>;
  issues?: CommandIssue[];
  cause?: unknown;
}

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly details?: Record<string, unknown>;
  readonly issues?: CommandIssue[];

  constructor(options: CommandErrorOptions) {
    super(options.message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CommandError";
    this.code = options.code;
    this.details = options.details;
    this.issues = options.issues;
  }
}
