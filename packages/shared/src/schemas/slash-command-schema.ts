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

export const slashCommandArgumentSpecSchema = z
  .object({
    name: slashCommandNameSchema,
    type: z.enum(["string", "integer", "number", "boolean"]).optional(),
    description: i18nTextLoose.optional(),
    required: z.boolean().optional(),
    variadic: z.boolean().optional(),
    choices: z.array(z.string().min(1)).min(1).max(64).optional(),
  })
  .strict();

export const slashCommandSpecSchema = z
  .object({
    name: slashCommandNameSchema,
    aliases: z.array(slashCommandNameSchema).max(16).optional(),
    description: i18nTextLoose,
    arguments: z.array(slashCommandArgumentSpecSchema).max(16).optional(),
    action: slashCommandNameSchema,
    context: z
      .array(z.enum(["session", "active-runtimes", "models"]))
      .max(3)
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
