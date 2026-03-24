import { z, type ZodType } from "zod";

const NonEmptyString = z.string().trim().min(1);

export interface CommandExecutionContext {
  actorId?: string;
  [key: string]: unknown;
}

export type CommandArgsSchema<TArgs = any> = ZodType<TArgs>;

export type CommandHandler<
  TArgs = any,
  TResult = any,
  TContext extends CommandExecutionContext = CommandExecutionContext
> = (args: TArgs, context: TContext) => TResult | Promise<TResult>;

export interface SlashCommandHelpMetadata {
  usage: string;
  examples?: string[];
}

export interface SlashCommandAutocompleteFlagHint {
  name: `--${string}`;
  description: string;
  takesValue: boolean;
}

export interface SlashCommandAutocompleteMetadata {
  positionalHints?: string[];
  flagHints?: SlashCommandAutocompleteFlagHint[];
}

export interface SlashCommandSpec<
  TArgs = any,
  TResult = any,
  TContext extends CommandExecutionContext = CommandExecutionContext
> {
  name: string;
  description: string;
  handler: string;
  resume: boolean;
  argsSchema: CommandArgsSchema<TArgs>;
  execute: CommandHandler<TArgs, TResult, TContext>;
  help?: SlashCommandHelpMetadata;
  autocomplete?: SlashCommandAutocompleteMetadata;
}

function isZodSchema(value: unknown): value is ZodType {
  return typeof value === "object" && value !== null && "safeParse" in value;
}

const CommandHelpMetadataSchema = z.object({
  usage: NonEmptyString,
  examples: z.array(NonEmptyString).optional()
});

const CommandAutocompleteMetadataSchema = z.object({
  positionalHints: z.array(NonEmptyString).optional(),
  flagHints: z.array(z.object({
    name: z.string().regex(/^--[a-z0-9-]+$/),
    description: NonEmptyString,
    takesValue: z.boolean()
  })).optional()
});

export const SlashCommandSpecSchema = z.object({
  name: z.string().trim().regex(/^[a-z][a-z0-9-]*$/),
  description: NonEmptyString,
  handler: NonEmptyString,
  resume: z.boolean(),
  argsSchema: z.custom<ZodType>(isZodSchema, {
    message: "argsSchema must be a zod schema"
  }),
  execute: z.custom<CommandHandler>((value) => typeof value === "function", {
    message: "execute must be a function"
  }),
  help: CommandHelpMetadataSchema.optional(),
  autocomplete: CommandAutocompleteMetadataSchema.optional()
});

export function createSlashCommandSpec<
  TArgs = any,
  TResult = any,
  TContext extends CommandExecutionContext = CommandExecutionContext
>(
  input: SlashCommandSpec<TArgs, TResult, TContext>
): SlashCommandSpec<TArgs, TResult, TContext> {
  return SlashCommandSpecSchema.parse(input) as SlashCommandSpec<TArgs, TResult, TContext>;
}
