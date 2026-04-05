import { createMapRegistry } from "@covel/shared";
import { CommandError } from "./error.js";

/** Execution context passed to command handlers. */
export interface CommandExecutionContext {
  sessionId?: string;
  actorId?: string;
  locale?: string;
  [key: string]: unknown;
}

/** Command handler function. */
export type CommandHandler<TArgs = unknown, TResult = unknown> = (
  args: TArgs,
  context: CommandExecutionContext
) => TResult | Promise<TResult>;

/** Args validator — matches Zod's safeParse interface. */
export interface ArgsValidator<TArgs = unknown> {
  safeParse(data: unknown): { success: true; data: TArgs } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
}

/** Help metadata for a command. */
export interface CommandHelpMeta {
  usage: string;
  examples?: string[];
}

/** Autocomplete flag hint. */
export interface CommandFlagHint {
  name: string;
  description: string;
  takesValue: boolean;
}

/** Autocomplete metadata for a command. */
export interface CommandAutocompleteMeta {
  positionalHints?: string[];
  flagHints?: CommandFlagHint[];
}

/** Registered command spec. */
export interface RegisteredCommand {
  name: string;
  pluginId: string;
  description: string;
  argsSchema?: ArgsValidator;
  handler: CommandHandler;
  help?: CommandHelpMeta;
  autocomplete?: CommandAutocompleteMeta;
}

/** Public summary returned from listCommands(). */
export interface CommandSummary {
  name: string;
  pluginId: string;
  description: string;
  usage: string;
  examples?: string[];
  positionalHints?: string[];
  flagHints?: CommandFlagHint[];
}

export interface CommandRegistry {
  register(cmd: RegisteredCommand): void;
  get(name: string): RegisteredCommand | undefined;
  getOrThrow(name: string): RegisteredCommand;
  list(): RegisteredCommand[];
  listSummaries(): CommandSummary[];
}

export function createCommandRegistry(): CommandRegistry {
  const store = createMapRegistry<RegisteredCommand>();

  function register(cmd: RegisteredCommand): void {
    if (!/^[a-z][a-z0-9-]*$/.test(cmd.name)) {
      throw new CommandError({
        code: "INVALID_COMMAND_INPUT",
        message: `Command name "${cmd.name}" must be kebab-case (a-z, 0-9, hyphens).`,
        details: { name: cmd.name },
      });
    }

    if (store.has(cmd.name)) {
      throw new CommandError({
        code: "DUPLICATE_COMMAND",
        message: `Command "${cmd.name}" is already registered.`,
        details: { name: cmd.name },
      });
    }

    store.add(cmd.name, cmd);
  }

  function get(name: string): RegisteredCommand | undefined {
    return store.get(name);
  }

  function getOrThrow(name: string): RegisteredCommand {
    const cmd = store.get(name);
    if (!cmd) {
      throw new CommandError({
        code: "COMMAND_NOT_FOUND",
        message: `Command "${name}" was not found.`,
        details: { name },
      });
    }
    return cmd;
  }

  function list(): RegisteredCommand[] {
    return store.list().sort((a, b) => a.name.localeCompare(b.name));
  }

  function listSummaries(): CommandSummary[] {
    return list().map((cmd) => ({
      name: cmd.name,
      pluginId: cmd.pluginId,
      description: cmd.description,
      usage: cmd.help?.usage ?? `/${cmd.name}`,
      ...(cmd.help?.examples ? { examples: cmd.help.examples } : {}),
      ...(cmd.autocomplete?.positionalHints
        ? { positionalHints: cmd.autocomplete.positionalHints }
        : {}),
      ...(cmd.autocomplete?.flagHints
        ? { flagHints: cmd.autocomplete.flagHints }
        : {}),
    }));
  }

  return { register, get, getOrThrow, list, listSummaries };
}
