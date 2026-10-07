/**
 * Built-in UI tools — generic building blocks for LLM-driven interactions.
 *
 * These are framework-level primitives. Plugins combine them via prompt
 * instructions without writing code:
 *   - char-creator calls `create-form` to build a character creation form
 *   - guide calls `create-choices` to show action options
 *   - any plugin can call `create-notification` to show alerts
 */

import { z } from "zod";
import { tool } from "./tool.js";

// ── render-ui ───────────────────────────────────────────────────

const uiPartStatusSchema = z.enum([
  "pending",
  "streaming",
  "success",
  "error",
  "paused",
]);

const uiRenderPartSchema = z.object({
  id: z.string().min(1).describe("Stable part id"),
  type: z
    .string()
    .min(1)
    .describe("Part type, for example text/image/audio/video/card"),
  status: uiPartStatusSchema.default("success").describe("Status of this part"),
  content: z
    .unknown()
    .optional()
    .describe("Part content; its structure depends on type"),
  retry: z
    .object({
      count: z.number().int().min(0),
      lastError: z.string().optional(),
    })
    .optional(),
});

export const renderUITool = tool({
  name: "render-ui",
  description:
    "Render one UI block made of independent parts. Each part has its own status. Use it to mix text, images, cards, audio and other media.",
  parameters: z.object({
    parts: z.array(uiRenderPartSchema).min(1).describe("List of UI parts"),
    layout: z
      .enum(["stream", "split", "overlay"])
      .optional()
      .describe("Layout"),
  }),
  execute: async (params) => ({
    rendered: true,
    ui: [
      {
        parts: params.parts,
        ...(params.layout ? { layout: params.layout } : {}),
      },
    ],
  }),
});

// ── create-form ──────────────────────────────────────────────────

/**
 * A select option. The bare string form uses one text for both jobs; the
 * object form separates them, which matters because the submitted value is
 * what `narrativeTemplate` interpolates.
 *
 * An option written to help the player choose ("旧地重游 —— 与青砾町有过一段旧事")
 * reads as a dash-inside-a-dash when spliced into a sentence. Giving the
 * option a short `value` and a descriptive `label` keeps the picker helpful
 * without dragging its explanation into the prose.
 */
const formFieldOptionSchema = z.union([
  z.string(),
  z.object({
    value: z
      .string()
      .min(1)
      .describe(
        "Submitted value; also the text inserted into the narrative template",
      ),
    label: z
      .string()
      .min(1)
      .describe("Full description shown to the player in the dropdown"),
  }),
]);

const formFieldSchema = z
  .object({
    type: z.enum(["text", "textarea", "select", "checkbox", "number"]),
    name: z.string().min(1),
    label: z.string().min(1),
    placeholder: z.string().optional(),
    options: z
      .array(formFieldOptionSchema)
      .optional()
      .describe(
        "Options of a select. For a string option the shown text is the submitted value. Use { value, label } when the player needs a detailed label and the narrative needs a short value.",
      ),
    required: z.boolean().optional(),
    defaultValue: z
      .union([z.string(), z.number().finite(), z.boolean()])
      .optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
  })
  .superRefine((field, ctx) => {
    if (
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max"],
        message: "max must be at least min",
      });
    }
    if (field.defaultValue !== undefined) {
      const expected =
        field.type === "number"
          ? "number"
          : field.type === "checkbox"
            ? "boolean"
            : "string";
      // Older plugin packages could only declare string defaults.
      const legacyDefault =
        typeof field.defaultValue === "string" &&
        ((field.type === "number" &&
          field.defaultValue.trim() !== "" &&
          Number.isFinite(Number(field.defaultValue))) ||
          (field.type === "checkbox" &&
            ["true", "false"].includes(field.defaultValue)));
      if (typeof field.defaultValue !== expected && !legacyDefault)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["defaultValue"],
          message: `defaultValue must be ${expected}`,
        });
    }
    if (field.type !== "select" || field.defaultValue === undefined) return;
    const values = (field.options ?? []).map((option) =>
      typeof option === "string" ? option : option.value,
    );
    if (!values.includes(String(field.defaultValue))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: `select defaultValue ${JSON.stringify(field.defaultValue)} must match a declared option value exactly. The option values are: ${values.map((value) => JSON.stringify(value)).join(", ")}`,
      });
    }
  });

const submitBehaviorSchema = z.object({
  echoFilledNarrative: z.boolean().optional(),
  immediate: z.boolean().optional(),
});

export const createFormTool = tool({
  name: "create-form",
  description:
    "Create a form for the player to fill in. The framework renders it in the client; the submitted values enter the next turn's context (through `{{ player.lastFormValues }}`). Use it for character creation, NPC dialogue choices, quest confirmation, or any input from the player. After submission, the plugin that created the form reads lastFormValues on the next turn and calls its own tool (for example create-character).",
  parameters: z.object({
    formId: z.string().min(1).describe("Unique form id"),
    title: z.string().min(1).describe("Form title"),
    fields: z.array(formFieldSchema).min(1).describe("Form fields"),
    submitLabel: z.string().min(1).describe("Text of the submit button"),
    narrativeTemplate: z
      .string()
      .describe(
        "Narrative template with {{fieldName}} placeholders. After submission the framework fills each one with that field's submitted value. " +
          "A select field supplies the option's value (a string option supplies itself), so an option written as " +
          "a short label followed by a long explanation puts the whole string into the narrative. In that case use { value, label }: " +
          "the short label in value, the explanation in label.",
      ),
    validation: z
      .object({ name: z.string().min(1), data: z.unknown().optional() })
      .optional(),
    submitBehavior: submitBehaviorSchema
      .optional()
      .describe(
        "Optional submit behavior: echo the filled narrative, submit immediately",
      ),
  }),
  execute: async (params) => {
    for (const field of params.fields) {
      if (field.type !== "select" || field.defaultValue === undefined) continue;
      const values = (field.options ?? []).map((option) =>
        typeof option === "string" ? option : option.value,
      );
      if (!values.includes(String(field.defaultValue))) {
        throw new Error(
          `select defaultValue must match a declared option value for ${field.name}`,
        );
      }
    }
    return {
      created: true,
      formId: params.formId,
      fieldCount: params.fields.length,
      interaction: {
        type: "form" as const,
        interactionId: params.formId,
        title: params.title,
        fields: params.fields,
        validation: params.validation,
        submitLabel: params.submitLabel,
        narrativeTemplate: params.narrativeTemplate,
        submitBehavior: params.submitBehavior,
      },
    };
  },
});

// ── create-choices ───────────────────────────────────────────────

const choiceSchema = z.object({
  id: z.string().min(1).describe("Unique choice id"),
  label: z.string().min(1).describe("Choice text"),
  description: z
    .string()
    .optional()
    .describe("Extra explanation of the choice"),
  category: z
    .string()
    .optional()
    .describe("Choice category: safe/aggressive/creative/wild and similar"),
});

export const createChoicesTool = tool({
  name: "create-choices",
  description:
    "Create a list of choices for the player. Use it for decision points, branching plot and NPC dialogue options. The chosen option enters the next turn's context.",
  parameters: z.object({
    choiceId: z.string().min(1).describe("Unique id of the choice group"),
    prompt: z
      .string()
      .min(1)
      .describe('Lead-in text, for example "What do you do?"'),
    choices: z.array(choiceSchema).min(2).describe("Choices (at least 2)"),
  }),
  execute: async (params) => ({
    created: true,
    choiceId: params.choiceId,
    choiceCount: params.choices.length,
    interaction: {
      type: "choice" as const,
      interactionId: params.choiceId,
      prompt: params.prompt,
      choices: params.choices,
    },
  }),
});

// ── create-notification ──────────────────────────────────────────

/**
 * The runtime only promotes a tool result that carries `ui` or `interaction`
 * (`findPresentableToolOutput`). A notification is not awaiting player input,
 * so it takes the `ui` channel: the block is normalized into a `ui.render`
 * proposal, and the renderer maps a part whose `content` is itself a
 * json-render spec onto that component — here `Alert`, whose props are
 * exactly level/title/message.
 */
export const createNotificationTool = tool({
  name: "create-notification",
  description:
    "Show a notification in the client. Use it for state changes, items gained, triggered events and similar.",
  parameters: z.object({
    level: z
      .enum(["info", "success", "warning", "error"])
      .describe("Notification level"),
    title: z.string().min(1).describe("Notification title"),
    message: z.string().min(1).describe("Notification body"),
  }),
  execute: async (params) => ({
    notified: true,
    level: params.level,
    ui: [
      {
        parts: [
          {
            id: "notification-1",
            type: "notification",
            status: "success" as const,
            content: {
              type: "Alert",
              props: {
                level: params.level,
                title: params.title,
                message: params.message,
              },
            },
          },
        ],
      },
    ],
  }),
});

// ── All built-in UI tools ────────────────────────────────────────

export const builtinUITools = [
  renderUITool,
  createFormTool,
  createChoicesTool,
  createNotificationTool,
];
