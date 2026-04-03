import { CommandError } from "./error.js";
import { parseSlashCommand } from "./parser.js";
import type {
  CommandRegistry,
  CommandExecutionContext,
} from "./command-registry.js";

/** Result from command execution. */
export interface CommandResult {
  content?: string;
  blocks?: Array<{ type: string; data: Record<string, unknown> }>;
  [key: string]: unknown;
}

export interface CommandBus {
  /**
   * Parse and dispatch a slash command.
   * @param input - Raw input string, e.g. `/guide --topic foo`
   * @param context - Execution context (sessionId, locale, etc.)
   */
  dispatch(input: string, context?: CommandExecutionContext): Promise<CommandResult>;
}

export function createCommandBus(registry: CommandRegistry): CommandBus {
  async function dispatch(
    input: string,
    context: CommandExecutionContext = {}
  ): Promise<CommandResult> {
    const parsed = parseSlashCommand(input);
    const cmd = registry.getOrThrow(parsed.name);

    // Validate args if schema provided
    let validatedArgs: unknown = parsed.args;
    if (cmd.argsSchema) {
      const result = cmd.argsSchema.safeParse(parsed.args);
      if (!result.success) {
        throw new CommandError({
          code: "ARGUMENT_VALIDATION_FAILED",
          message: `Arguments for "${cmd.name}" did not pass validation.`,
          details: { commandName: cmd.name },
          issues: result.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        });
      }
      validatedArgs = result.data;
    }

    return Promise.resolve(cmd.handler(validatedArgs, context)) as Promise<CommandResult>;
  }

  return { dispatch };
}
