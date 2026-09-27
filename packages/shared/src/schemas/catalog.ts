import { z } from "zod";
import { i18nTextSchema } from "./world.js";

/** Values in action payloads may select from the row, component props or uploaded media. */
export const catalogActionSchema = z.strictObject({
  pluginId: z.string().min(1),
  runtimeId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  label: i18nTextSchema.optional(),
});
export type CatalogAction = z.infer<typeof catalogActionSchema>;
export const catalogFieldSchema = z.strictObject({
  path: z.string().min(1),
  label: i18nTextSchema.optional(),
});
export const candidateListPropsSchema = z.object({
  candidates: z.array(z.record(z.string(), z.unknown())),
  idField: z.string().default("id"),
  contentField: z.string().default("content"),
  detailFields: z.array(z.string()).optional(),
  hiddenWhen: z
    .strictObject({ field: z.string(), equals: z.unknown() })
    .optional(),
  acceptedId: z.string().optional(),
  turnId: z.string().optional(),
  acceptAction: catalogActionSchema.optional(),
  regenerateAction: catalogActionSchema.optional(),
});
export const mediaGalleryPropsSchema = z.object({
  items: z.unknown(),
  idField: z.string().default("id"),
  refField: z.string().default("ref"),
  titleField: z.string().optional(),
  statusField: z.string().optional(),
  errorField: z.string().optional(),
  durationField: z.string().optional(),
  fields: z.array(catalogFieldSchema).optional(),
  rerunAction: catalogActionSchema.optional(),
});
export const entryListPropsSchema = z.object({
  items: z.unknown(),
  idField: z.string().default("id"),
  titleField: z.string(),
  descriptionFields: z.array(z.string()).optional(),
  badgeFields: z.array(z.string()).optional(),
  fields: z.array(catalogFieldSchema).optional(),
  dateField: z.string().optional(),
  footerField: z.string().optional(),
});
export const jobListPropsSchema = z.object({
  items: z.unknown(),
  idField: z.string().default("jobId"),
  statusField: z.string().default("status"),
  messageField: z.string().default("message"),
  errorField: z.string().default("error"),
  durationField: z.string().default("durationMs"),
  fields: z.array(catalogFieldSchema).optional(),
  rerunAction: catalogActionSchema.optional(),
  relatedMedia: z
    .strictObject({
      items: z.unknown(),
      itemField: z.string(),
      matchField: z.string(),
      refField: z.string().default("ref"),
      idField: z.string().default("id"),
      titleField: z.string().optional(),
    })
    .optional(),
});
