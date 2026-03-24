import { z } from "zod";

import { CommandError, type CommandIssue } from "./error.js";
import { SlashParser } from "./parser.js";
import { CommandRegistry } from "./registry.js";
import type { CommandExecutionContext } from "./spec.js";

export interface CommandBusOptions {
  registry: CommandRegistry;
  parser?: SlashParser;
}

export class CommandBus {
  readonly #registry: CommandRegistry;
  readonly #parser: SlashParser;

  constructor(options: CommandBusOptions) {
    this.#registry = options.registry;
    this.#parser = options.parser ?? new SlashParser();
  }

  async dispatch<TContext extends CommandExecutionContext = CommandExecutionContext>(
    input: string,
    context = {} as TContext
  ): Promise<unknown> {
    const parsedCommand = this.#parser.parse(input);
    const spec = this.#registry.getOrThrow(parsedCommand.name);
    const validationResult = spec.argsSchema.safeParse(parsedCommand.args);

    if (!validationResult.success) {
      throw new CommandError({
        code: "ARGUMENT_VALIDATION_FAILED",
        message: `Arguments for '${spec.name}' did not satisfy argsSchema.`,
        details: {
          commandName: spec.name
        },
        issues: mapZodIssues(validationResult.error.issues)
      });
    }

    return spec.execute(validationResult.data, context);
  }
}

function mapZodIssues(issues: z.ZodIssue[]): CommandIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message
  }));
}
