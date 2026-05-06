import { z } from "zod";

const providerProtocolSchema = z.enum([
	"openai-chat-v1",
	"openai-responses-v1",
	"anthropic-messages-v1",
]);

const operationModeSchema = z.enum([
	"text",
	"object",
	"stream",
	"embed",
	"image",
	"speech",
	"transcription",
]);

const modelTierSchema = z.enum(["small", "medium", "large", "embed-default"]);

export const providerDefaultsSchema = z.object({
	baseUrl: z.string().optional(),
	protocol: providerProtocolSchema.optional(),
	headers: z.record(z.string(), z.string()).optional(),
});

export const modelProfileSchema = z.object({
	id: z.string(),
	tier: modelTierSchema,
	provider: z.string(),
	model: z.string(),
	contextWindow: z.number().int().positive(),
	latencyClass: z.string(),
	costClass: z.string(),
	supportedModes: z.array(operationModeSchema),
});

export const presetConfigSchema = z.object({
	id: z.string(),
	name: z.string(),
	provider: z.string(),
	protocol: providerProtocolSchema.optional(),
	model: z.string(),
	tier: z.enum(["small", "medium", "large"]),
	baseUrl: z.string().optional(),
	fallbackPresetIds: z.array(z.string()).optional(),
	supportedModes: z.array(operationModeSchema),
	enabled: z.boolean().default(true),
	isDefault: z.boolean().optional(),
	scope: z.string().optional(),
	defaultSlot: z.string().optional(),
	providerRequestMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const aiConfigSchema = z.object({
	providers: z.record(z.string(), providerDefaultsSchema).default({}),
	profiles: z.array(modelProfileSchema).default([]),
	presets: z.array(presetConfigSchema).default([]),
});

export type AiConfigInput = z.input<typeof aiConfigSchema>;
