import { z } from "zod";

const i18nTextLoose = z.union([z.string(), z.record(z.string(), z.string())]);

const slashCommandNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/, {
    message:
      "command names must be lowercase kebab-case without a leading slash",
  });

const slashCommandArgumentSpecSchema = z
  .object({
    name: slashCommandNameSchema.describe(
      "Argument name in lowercase kebab-case.",
    ),
    type: z
      .enum(["string", "integer", "number", "boolean"])
      .describe("Value type of the argument. Defaults to string.")
      .optional(),
    description: i18nTextLoose
      .describe("What the argument means. Shown to the player.")
      .optional(),
    required: z
      .boolean()
      .describe("`true` when the player must supply the argument.")
      .optional(),
    variadic: z
      .boolean()
      .describe(
        "`true` collects all remaining words. Only the last argument can be variadic.",
      )
      .optional(),
    choices: z
      .array(z.string().min(1))
      .min(1)
      .max(64)
      .describe("Allowed values of the argument.")
      .optional(),
  })
  .strict();

export const slashCommandSpecSchema = z
  .object({
    name: slashCommandNameSchema.describe(
      "Command name in lowercase kebab-case, without the leading slash.",
    ),
    aliases: z
      .array(slashCommandNameSchema)
      .max(16)
      .describe("Other names that invoke the same command.")
      .optional(),
    description: i18nTextLoose.describe(
      "What the command does. Shown to the player.",
    ),
    arguments: z
      .array(slashCommandArgumentSpecSchema)
      .max(16)
      .describe("Positional arguments, in order. Names must be unique.")
      .optional(),
    action: slashCommandNameSchema.describe(
      "RPC action the command invokes. It must be listed in `contributes.actions`.",
    ),
    context: z
      .array(z.enum(["session", "active-runtimes", "models"]))
      .max(3)
      .describe("Host context scopes passed to the action.")
      .optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    const names = [command.name, ...(command.aliases ?? [])];
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: "custom",
        path: ["aliases"],
        message: "command name and aliases must be unique",
      });
    }
    const argumentNames =
      command.arguments?.map((argument) => argument.name) ?? [];
    if (new Set(argumentNames).size !== argumentNames.length) {
      ctx.addIssue({
        code: "custom",
        path: ["arguments"],
        message: "command argument names must be unique",
      });
    }
    const variadicIndex = command.arguments?.findIndex(
      (argument) => argument.variadic === true,
    );
    if (
      variadicIndex !== undefined &&
      variadicIndex >= 0 &&
      variadicIndex !== (command.arguments?.length ?? 0) - 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["arguments", variadicIndex, "variadic"],
        message: "a variadic command argument must be last",
      });
    }
    const scopes = command.context ?? [];
    if (new Set(scopes).size !== scopes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["context"],
        message: "command context scopes must be unique",
      });
    }
  });
