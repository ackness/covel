import { z } from "zod";

/** Stable report/error codes; clients may localize these and fall back to message. */
export const ST_IMPORT_CODES = [
  "files-required",
  "files-limit",
  "cards-limit",
  "file-too-large",
  "unsupported-file",
  "json-invalid",
  "json-too-large",
  "card-invalid",
  "card-spec-unsupported",
  "card-no-name",
  "lorebook-invalid",
  "locale-invalid",
  "png-invalid",
  "png-chunks-limit",
  "png-no-card",
  "png-unsupported-text-chunk",
  "png-base64-invalid",
  "png-utf8-invalid",
  "id-conflict",
  "no-usable-text",
  "lorebook-too-large",
  "v1-card",
  "field-ignored",
  "extensions-ignored",
  "alternate-greetings-unsupported",
  "instructions-in-world-text",
  "mes-example-unparsed",
  "text-truncated",
  "html-removed",
  "macros-removed",
  "regex-keys-dropped",
  "lorebook-feature-dropped",
  "entries-skipped-empty",
  "entry-skipped-no-keys",
  "entries-limit",
] as const;

export const stImportItemSchema = z
  .object({
    level: z.enum(["info", "warning", "error"]),
    code: z.string().min(1),
    source: z.string().optional(),
    field: z.string().optional(),
    count: z.number().int().nonnegative().optional(),
    message: z.string(),
  })
  .strict();

export const stImportReportSchema = z
  .object({
    sources: z.array(
      z
        .object({
          file: z.string(),
          kind: z.enum(["card-v3", "card-v2", "card-v1", "lorebook"]),
          name: z.string().optional(),
        })
        .strict(),
    ),
    world: z
      .object({
        id: z.string(),
        name: z.string(),
        locale: z.string(),
        summary: z.string(),
      })
      .strict(),
    counts: z
      .object({
        characters: z.number().int().nonnegative(),
        loreEntries: z.number().int().nonnegative(),
        hasCover: z.boolean(),
      })
      .strict(),
    items: z.array(stImportItemSchema),
  })
  .strict();

export const stImportResultSchema = z
  .object({
    ok: z.literal(true),
    preview: z.boolean(),
    kind: z.literal("world"),
    id: z.string().min(1),
    restartRequired: z.literal(false),
    report: stImportReportSchema,
  })
  .strict();
export const stImportPreviewSchema = stImportResultSchema.extend({
  preview: z.literal(true),
});
export type StImportItem = z.infer<typeof stImportItemSchema>;
export type StImportReport = z.infer<typeof stImportReportSchema>;
export type StImportResult = z.infer<typeof stImportResultSchema>;
export type StImportPreview = z.infer<typeof stImportPreviewSchema>;
