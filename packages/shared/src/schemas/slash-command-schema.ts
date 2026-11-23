import { z } from "zod";
import { configFlowIdSchema } from "../platform/index.js";
import { rpcActionNameSchema } from "./rpc-action.js";
import { PLUGIN_VIEW_ID_PATTERN } from "./view-mode.js";

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
    scope: z
      .enum(["session", "instance"])
      .describe(
        "Where this command appears: `session` (default, slash commands) or `instance` (application command palette).",
      )
      .optional(),
    palette: z
      .boolean()
      .describe("When true, surface in the global command palette (⌘K).")
      .optional(),
    shortcutHint: z
      .string()
      .min(1)
      .max(24)
      .describe("Optional keyboard shortcut hint shown in the command palette.")
      .optional(),
    action: slashCommandNameSchema
      .describe(
        "Session RPC action the command invokes. Must be listed in `contributes.actions`.",
      )
      .optional(),
    appAction: rpcActionNameSchema
      .describe(
        "Instance app action the command invokes. Must be listed in `contributes.appActions`.",
      )
      .optional(),
    openFlow: configFlowIdSchema
      .describe(
        "Declarative Config Flow ID the command launches. Must be listed in `contributes.flows`.",
      )
      .optional(),
    openPage: z
      .string()
      .regex(PLUGIN_VIEW_ID_PATTERN)
      .describe("Application page ID (`contributes.ui.appPage`) to open.")
      .optional(),
    openWindow: z
      .string()
      .regex(PLUGIN_VIEW_ID_PATTERN)
      .describe("Floating window ID (`contributes.ui.window`) to open.")
      .optional(),
    context: z
      .array(z.enum(["session", "active-runtimes", "models"]))
      .max(3)
      .describe("Host context scopes passed to the action.")
      .optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    const targets = [
      command.action,
      command.appAction,
      command.openFlow,
      command.openPage,
      command.openWindow,
    ].filter((value) => value !== undefined);
    if (targets.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["action"],
        message:
          "command requires one target: action, appAction, openFlow, openPage, or openWindow",
      });
    } else if (targets.length > 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "command may specify only one target among action, appAction, openFlow, openPage, and openWindow",
      });
    }
    if (command.scope === "instance" && command.action !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["action"],
        message: 'session `action` cannot be used with scope: "instance"',
      });
    }
    if (
      command.scope === "session" &&
      (command.appAction !== undefined ||
        command.openFlow !== undefined ||
        command.openPage !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          'appAction, openFlow, and openPage cannot be used with scope: "session"',
      });
    }
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
