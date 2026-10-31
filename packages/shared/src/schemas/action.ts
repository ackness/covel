/**
 * Actions: the shapes a player submission and a plugin's action-kind
 * declaration take, the base kinds and the role table. The server reads the
 * role table and the base-kind rules from here and nowhere else; the docs
 * table in `reference/world-model.md` mirrors them.
 */

import { z } from "zod";
import type { SeatRole } from "@covel/plugin-handlers-utils";
import { i18nTextSchema } from "./world.js";
import type {
  ActionKindRule,
  ActionTextRule,
  BaseActionKind,
} from "../types/action.js";

import {
  MAX_PLAYER_MESSAGE_CHARS,
  MAX_ACTIONS_PER_SUBMISSION,
  turnActionRequestSchema,
} from "@covel/plugin-handlers-utils";
export {
  MAX_PLAYER_MESSAGE_CHARS,
  MAX_ACTIONS_PER_SUBMISSION,
  turnActionRequestSchema,
  turnActionSchema,
} from "@covel/plugin-handlers-utils";

/** The kernel's own action kinds. A bare kind name always means one of these. */
export const BASE_ACTION_KINDS: readonly BaseActionKind[] = Object.freeze([
  "say",
  "act",
  "narrate",
  "direct",
  "advance",
  "command",
] as const);

/** The base kinds each seat role may submit. Plugin kinds declare their own roles. */
export const ROLE_ACTION_KINDS: Readonly<
  Record<SeatRole, readonly BaseActionKind[]>
> = Object.freeze({
  player: Object.freeze(["say", "act", "command"] as const),
  host: Object.freeze(["narrate", "direct", "advance", "command"] as const),
  spectator: Object.freeze(["advance"] as const),
});

/**
 * What each base kind takes. `say` and `act` are taken as a character; the
 * others are not. `advance` carries no text; `command` text starts with `/`.
 */
export const BASE_ACTION_KIND_RULES: Readonly<
  Record<BaseActionKind, Omit<ActionKindRule, "kind" | "roles">>
> = Object.freeze({
  say: { text: "required", actor: true },
  act: { text: "required", actor: true },
  narrate: { text: "required", actor: false },
  direct: { text: "required", actor: false },
  advance: { text: "none", actor: false },
  command: { text: "required", actor: false },
});

/** True for a kernel kind name; a plugin kind is always namespaced. */
export function isBaseActionKind(kind: string): kind is BaseActionKind {
  return (BASE_ACTION_KINDS as readonly string[]).includes(kind);
}

/** The roles that may submit a base kind, from the role table. */
export function baseActionKindRoles(kind: BaseActionKind): SeatRole[] {
  return (Object.keys(ROLE_ACTION_KINDS) as SeatRole[]).filter((role) =>
    ROLE_ACTION_KINDS[role].includes(kind),
  );
}

/** The wire ID of a plugin's action kind: `<pluginId>/<name>`. */
export function pluginActionKindId(pluginId: string, name: string): string {
  return `${pluginId}/${name}`;
}

/**
 * The kind an interaction answer is submitted as: the kind the interaction
 * declares in `actionKind`, else `say` for a choice and `act` for a form or a
 * confirmation.
 */
export function interactionActionKind(
  type: "form" | "choice" | "confirmation",
  declared?: unknown,
): string {
  if (typeof declared === "string" && declared.length > 0) return declared;
  return type === "choice" ? "say" : "act";
}

/** A plugin action-kind name: lower-case kebab-case. */
export const ACTION_KIND_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const actionTextRuleSchema: z.ZodType<ActionTextRule> = z.enum([
  "required",
  "optional",
  "none",
]);

const seatRoleSchema = z.enum(["player", "host", "spectator"]);

/** One authored `contributes.actionKinds` item. */
export const actionKindDeclarationSchema = z.strictObject({
  name: z
    .string()
    .regex(ACTION_KIND_NAME_PATTERN, {
      message: "name must be lower-case kebab-case",
    })
    .describe(
      "Kind name, unique in the package and not a base kind. The wire kind is `<pluginId>/<name>`.",
    ),
  roles: z
    .array(seatRoleSchema)
    .min(1)
    .describe("Seat roles that may submit this kind. Defaults to `[player]`.")
    .optional(),
  text: actionTextRuleSchema
    .describe(
      "Whether the action carries text: `required`, `optional` (default) or `none`.",
    )
    .optional(),
  actor: z
    .boolean()
    .describe(
      "Whether the action is taken as a character. Defaults to `true`: the seat's current character unless the action names another bound one.",
    )
    .optional(),
  schema: z
    .string()
    .min(1)
    .describe(
      "Package-relative path of the JSON Schema the action's `fields` must match. Without it the kind takes no fields.",
    )
    .optional(),
  display: z
    .strictObject({
      label: i18nTextSchema.describe(
        "Name of the kind, for the composer and for the model-facing rendering of the action.",
      ),
      icon: z
        .string()
        .min(1)
        .describe("Icon name for the composer.")
        .optional(),
      placeholder: i18nTextSchema
        .describe("Placeholder text for the composer.")
        .optional(),
    })
    .describe("How the composer shows the kind."),
});

/** The actions of one submission: 1 to 8, their text within the limit together. */
export const turnActionRequestsSchema = z
  .array(turnActionRequestSchema)
  .min(1, { message: "submit_actions.actions must not be empty" })
  .max(MAX_ACTIONS_PER_SUBMISSION, {
    message: `submit_actions.actions holds at most ${MAX_ACTIONS_PER_SUBMISSION} actions`,
  })
  .refine(
    (actions) =>
      actions.reduce(
        (total, action) => total + (action.text?.length ?? 0),
        0,
      ) <= MAX_PLAYER_MESSAGE_CHARS,
    {
      message: `submit_actions text must be at most ${MAX_PLAYER_MESSAGE_CHARS} characters in total`,
    },
  );
