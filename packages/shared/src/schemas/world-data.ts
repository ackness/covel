import { z } from "zod";

export const worldDataSourceIdRegex = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

export const worldDataSourceIdSchema = z
	.string()
	.regex(worldDataSourceIdRegex, {
		message:
			"source id must start with a letter and contain only letters, numbers, _ or -",
	});

export const worldDataSourceKindSchema = z.enum([
	"yaml",
	"json",
	"markdown",
	"text",
	"media",
]);

export const worldDataMergeModeSchema = z.enum(["replace", "skipExisting"]);

export const worldDataEffectSchema = z.enum(["characters"]);

const afterSchema = z.union([
	worldDataSourceIdSchema,
	z.array(worldDataSourceIdSchema).min(1),
]);

export const worldDataSourceDescriptorSchema = z
	.object({
		kind: worldDataSourceKindSchema,
		path: z.string().min(1),
		schema: z.string().min(1).optional(),
		to: z.string().min(1),
		key: z.string().min(1).optional(),
		indexTo: z.string().min(1).optional(),
		effects: z.array(worldDataEffectSchema).optional(),
		enabled: z.boolean().optional(),
		locale: z.string().min(2).optional(),
		merge: worldDataMergeModeSchema.optional(),
		after: afterSchema.optional(),
	})
	.strict();

export const worldDataDescriptorSchema = z
	.object({
		schemaVersion: z.literal(1),
		sources: z.record(worldDataSourceIdSchema, worldDataSourceDescriptorSchema),
	})
	.strict();

export const worldDataSourceDescriptorOverrideSchema =
	worldDataSourceDescriptorSchema.partial().strict();

export const worldDataDescriptorOverrideSchema = z
	.object({
		schemaVersion: z.literal(1),
		sources: z.record(
			worldDataSourceIdSchema,
			worldDataSourceDescriptorOverrideSchema,
		),
	})
	.strict();

export const worldDataDiagnosticCountsSchema = z
	.object({
		info: z.number().int().min(0),
		warning: z.number().int().min(0),
		error: z.number().int().min(0),
	})
	.strict();

export const worldDataSourceSummarySchema = z
	.object({
		id: worldDataSourceIdSchema,
		digest: z.string().min(1),
		target: z.string().min(1),
		schema: z.string().min(1).optional(),
		importedAt: z.string().min(1).optional(),
		order: z.number().int().min(0),
		origin: z.enum(["world", "override"]),
		overridden: z.boolean().optional(),
		diagnostics: worldDataDiagnosticCountsSchema,
	})
	.strict();

export const worldDataMetadataSummarySchema = z
	.object({
		schemaVersion: z.literal(1),
		sources: z.array(worldDataSourceSummarySchema),
	})
	.strict();

export type WorldDataDescriptorInput = z.input<
	typeof worldDataDescriptorSchema
>;

export type WorldDataDescriptorOverrideInput = z.input<
	typeof worldDataDescriptorOverrideSchema
>;
