import { kernelExtensionPoints, kernelUiSlots } from "./contracts.js";
import { z } from "zod";
import { defineExtensionPoint } from "./definition.js";
import { mediaRefSchema } from "../types/media.js";
import { i18nTextSchema } from "../schemas/world.js";

const visualRequestSchema = z.strictObject({
  variantId: z.string().optional(),
  outfit: z.string().optional(),
  expression: z.string().optional(),
  pose: z.string().optional(),
});
const framingSchema = z.strictObject({
  scale: z.number().min(0.5).max(2).optional(),
  offsetX: z.number().min(-100).max(100).optional(),
  offsetY: z.number().min(-100).max(100).optional(),
});
export const characterVisualSchema = z.strictObject({
  characterId: z.string().min(1),
  displayName: z.string().optional(),
  avatar: mediaRefSchema.optional(),
  sprite: mediaRefSchema.optional(),
  visuals: z
    .strictObject({
      defaultVariant: z.string().optional(),
      variants: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            outfit: z.string().optional(),
            expression: z.string().optional(),
            pose: z.string().optional(),
            sprite: mediaRefSchema,
            stage: framingSchema.optional(),
          }),
        )
        .max(64),
    })
    .optional(),
});
export const characterVisualCollectionSchema = z.strictObject({
  characters: z.array(characterVisualSchema).max(1024),
});
export const stageBackdropSchema = z.strictObject({
  sceneId: z.string().optional(),
  name: z.string().optional(),
  ref: mediaRefSchema.optional(),
  variant: z.enum(["day", "night"]).optional(),
  label: i18nTextSchema.optional(),
  preload: z.array(mediaRefSchema).optional(),
});
export const stageCastSchema = z.strictObject({
  actors: z
    .array(
      z.strictObject({
        characterId: z.string().min(1),
        displayName: z.string().min(1),
        type: z.string().optional(),
        description: z.string().optional(),
        active: z.boolean().optional(),
        exiting: z.boolean().optional(),
        visual: visualRequestSchema.optional(),
        position: z
          .enum(["left", "center-left", "center", "center-right", "right"])
          .optional(),
        transition: z
          .enum(["none", "fade", "slide-left", "slide-right", "dissolve"])
          .optional(),
      }),
    )
    .max(64),
  retainWhenEmpty: z.boolean(),
});
export const stageDialogueSchema = z.strictObject({
  turnId: z.string().optional(),
  paragraphSpeakers: z.array(z.string().nullable()).max(80),
});
export const stageChoicesSchema = z.strictObject({
  turnId: z.string().optional(),
  scene: i18nTextSchema.optional(),
  recap: i18nTextSchema.optional(),
  decision: i18nTextSchema.optional(),
  choices: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        text: z.string(),
        label: i18nTextSchema.optional(),
      }),
    )
    .max(64),
});
const summaryEntryBase = {
  id: z.string().min(1).max(64),
  label: i18nTextSchema,
};
const summaryToneSchema = z.enum(["info", "success", "warning", "danger"]);
/**
 * What a plugin wants the player to see at a glance, wherever the active
 * layout keeps status: a line of text (the current objective, the time), a
 * gauge, or a short list (what is carried). Each provider appends its entries
 * to the ones before it; `id` is unique per provider.
 */
export const sessionSummaryEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...summaryEntryBase,
    kind: z.literal("text"),
    value: i18nTextSchema,
    tone: summaryToneSchema.optional(),
  }),
  z.strictObject({
    ...summaryEntryBase,
    kind: z.literal("meter"),
    value: z.number(),
    max: z.number(),
    min: z.number().optional(),
    tone: summaryToneSchema.optional(),
  }),
  z.strictObject({
    ...summaryEntryBase,
    kind: z.literal("list"),
    items: z.array(i18nTextSchema).max(24),
    /** Count of all items when `items` is only the first few. */
    total: z.number().int().nonnegative().optional(),
  }),
]);
export const sessionSummarySchema = z.strictObject({
  entries: z.array(sessionSummaryEntrySchema).max(16),
});
export const uiSlotValueSchemas = {
  [kernelUiSlots.backdrop]: stageBackdropSchema,
  [kernelUiSlots.cast]: stageCastSchema,
  [kernelUiSlots.dialogue]: stageDialogueSchema,
  [kernelUiSlots.choices]: stageChoicesSchema,
  [kernelUiSlots.characterVisual]: characterVisualSchema,
  [kernelUiSlots.summary]: sessionSummarySchema,
} as const;
export const uiSlotNameSchema = z.enum(Object.values(kernelUiSlots));
export type UiSlotName = z.infer<typeof uiSlotNameSchema>;
export type StageBackdropModel = z.infer<typeof stageBackdropSchema>;
export type StageCastModel = z.infer<typeof stageCastSchema>;
export type StageDialogueModel = z.infer<typeof stageDialogueSchema>;
export type StageChoicesModel = z.infer<typeof stageChoicesSchema>;
export type CharacterVisualModel = z.infer<typeof characterVisualSchema>;
export type SessionSummaryEntry = z.infer<typeof sessionSummaryEntrySchema>;
export type SessionSummaryModel = z.infer<typeof sessionSummarySchema>;
const valueSchema = z.union([
  stageBackdropSchema,
  stageCastSchema,
  stageDialogueSchema,
  stageChoicesSchema,
  characterVisualSchema,
  characterVisualCollectionSchema,
  sessionSummarySchema,
  z.null(),
]);
export type UiSlotValue = z.infer<typeof valueSchema>;
export const uiSlotSnapshotSchema = z.strictObject({
  slot: uiSlotNameSchema,
  key: z.string().optional(),
  value: valueSchema,
  revision: z.string().min(1),
});
export type UiSlotSnapshot = z.infer<typeof uiSlotSnapshotSchema>;
export const uiSlotInputSchema = z.strictObject({
  slot: uiSlotNameSchema,
  key: z.string().optional(),
  previous: valueSchema,
  events: z.array(
    z.strictObject({
      topic: z.string(),
      data: z.record(z.string(), z.unknown()),
      turnId: z.string(),
      pluginId: z.string().optional(),
    }),
  ),
});
export type UiSlotProjectionInput = z.infer<typeof uiSlotInputSchema>;
export const uiSlotV1 = defineExtensionPoint({
  ...kernelExtensionPoints.uiSlot,
  input: uiSlotInputSchema,
  output: valueSchema,
  timeoutMs: 500,
  onError: "skip",
  matchesProvider: (input, provider) => input.slot === provider.slot,
  initialOutput: (input) => input.previous,
  attributeOutput: (value, provider) => {
    if (value === null) return null;
    const slot = uiSlotNameSchema.parse(provider.slot);
    return slot === "character.visual@1"
      ? characterVisualCollectionSchema.parse(value)
      : uiSlotValueSchemas[slot].parse(value);
  },
  nextInput: (input, output) => ({ ...input, previous: output }),
});
