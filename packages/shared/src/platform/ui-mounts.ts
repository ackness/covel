import { z } from "zod";
import { promptWhenSchema } from "./prompt-governance.js";
import { rpcActionNameSchema } from "../schemas/rpc-action.js";
import { PLUGIN_VIEW_ID_PATTERN } from "../schemas/view-mode.js";

export const UI_SETTINGS_GROUPS = [
  "general",
  "llm",
  "plugins",
  "data",
  "advanced",
] as const;

export type UiSettingsGroup = (typeof UI_SETTINGS_GROUPS)[number];

export const TOPBAR_STATUS_TONES = [
  "idle",
  "ok",
  "syncing",
  "warning",
  "error",
] as const;

export type TopbarStatusTone = (typeof TOPBAR_STATUS_TONES)[number];

export const INSTANCE_UI_SLOTS = [
  "settingsSection",
  "appPage",
  "topbarStatus",
] as const;

export const SESSION_MICRO_UI_SLOTS = [
  "composerAction",
  "messageAction",
  "messageBelow",
] as const;

const i18nTextLoose = z.union([z.string(), z.record(z.string(), z.string())]);

export const topbarStatusSpecSchema = z.strictObject({
  id: z.string().regex(PLUGIN_VIEW_ID_PATTERN),
  label: i18nTextLoose,
  icon: z.string().min(1).max(64).optional(),
  statusAction: rpcActionNameSchema.optional(),
  dataSource: z
    .strictObject({
      source: z.literal("instance.data"),
      namespace: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      key: z.string().min(1).max(128).optional(),
    })
    .optional(),
  defaultStatus: z
    .strictObject({
      tone: z.enum(TOPBAR_STATUS_TONES),
      text: i18nTextLoose,
    })
    .optional(),
  pollIntervalSec: z.number().int().min(10).max(600).optional(),
});

export type TopbarStatusSpec = z.infer<typeof topbarStatusSpecSchema>;

export const composerActionSpecSchema = z
  .strictObject({
    id: z.string().regex(PLUGIN_VIEW_ID_PATTERN),
    label: i18nTextLoose,
    tooltip: i18nTextLoose.optional(),
    icon: z.string().min(1).max(64),
    action: rpcActionNameSchema.optional(),
    command: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .optional(),
    openWindow: z.string().regex(PLUGIN_VIEW_ID_PATTERN).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    whenFact: promptWhenSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    const targets = [spec.action, spec.command, spec.openWindow].filter(
      (value) => value !== undefined,
    );
    if (targets.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "composerAction must specify exactly one target of action, command, or openWindow",
      });
    }
  });

export type ComposerActionSpec = z.infer<typeof composerActionSpecSchema>;

export const messageActionSpecSchema = z.strictObject({
  id: z.string().regex(PLUGIN_VIEW_ID_PATTERN),
  label: i18nTextLoose,
  tooltip: i18nTextLoose.optional(),
  icon: z.string().min(1).max(64),
  action: rpcActionNameSchema,
  roles: z
    .array(z.enum(["user", "assistant"]))
    .min(1)
    .max(2)
    .optional(),
  kinds: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
  activeField: z.string().min(1).max(64).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type MessageActionSpec = z.infer<typeof messageActionSpecSchema>;
