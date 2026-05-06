import { z } from "zod";

const providerProtocolSchema = z.enum([
	"openai-chat-v1",
	"openai-responses-v1",
	"anthropic-messages-v1",
]);

const inputModalitySchema = z.enum(["text", "image", "audio", "video", "file"]);
const outputModalitySchema = z.enum(["text", "image", "audio", "embedding"]);
const modelFeatureSchema = z.enum([
	"function_calling",
	"structured_output",
	"streaming",
	"reasoning",
	"vision",
	"prompt_caching",
	"web_search",
	"computer_use",
]);

const pricingSchema = z
	.object({
		inputPerMToken: z.number().optional(),
		outputPerMToken: z.number().optional(),
		imageInputPerMToken: z.number().optional(),
		audioInputPerMToken: z.number().optional(),
		audioOutputPerMToken: z.number().optional(),
		perImage: z.number().optional(),
	})
	.optional();

/**
 * Schema for a single slot definition in llm.toml.
 *
 * Example:
 * ```toml
 * [covel.main]
 * provider = "deepseek"
 * model    = "deepseek-chat"
 * baseUrl  = "https://api.deepseek.com"
 * protocol = "openai-chat-v1"
 * fallback = "fast"
 *
 * # Optional capability overrides (auto-inferred if omitted):
 * input    = ["text"]
 * output   = ["text"]
 * features = ["function_calling", "streaming"]
 * contextWindow   = 131072
 * maxOutputTokens = 8192
 *
 * [covel.main.pricing]
 * inputPerMToken  = 0.27
 * outputPerMToken = 1.1
 * ```
 */
export const slotDefinitionSchema = z.object({
	/** Provider identifier — maps to {PROVIDER}_API_KEY in .env.llm */
	provider: z.string().min(1),
	/** Model ID passed to the provider API */
	model: z.string().min(1),
	/** API endpoint URL */
	baseUrl: z.string().url(),
	/** Wire protocol */
	protocol: providerProtocolSchema,
	/** Optional: slot name to fall back to on failure */
	fallback: z.string().optional(),
	/** Capability tag. Auto-inferred from output modalities if omitted. */
	tag: z.string().optional(),
	/**
	 * Embeddings request body format for embed slots.
	 *   "openai" (default)       — standard `{input: string[]}` (OpenAI, Ollama, most OpenRouter text embedders)
	 *   "nemotron-multimodal"    — OpenRouter NVIDIA Nemotron multimodal shape `{input: [{content: [...]}]}`
	 * Only meaningful when output includes "embedding".
	 */
	embeddingFormat: z.enum(["openai", "nemotron-multimodal"]).optional(),

	// ── Capability overrides (all optional, auto-inferred from known model DB) ──

	/** What the model accepts as input (e.g. ["text", "image"] for vision) */
	input: z.array(inputModalitySchema).optional(),
	/** What the model produces as output (e.g. ["text"], ["image"] for image gen) */
	output: z.array(outputModalitySchema).optional(),
	/** Feature flags */
	features: z.array(modelFeatureSchema).optional(),
	/** Max input context window (tokens) */
	contextWindow: z.number().int().positive().optional(),
	/** Max output tokens */
	maxOutputTokens: z.number().int().nonnegative().optional(),
	/** Pricing info */
	pricing: pricingSchema,

	// ── Thinking-mode controls (optional) ────────────────────────────

	/**
	 * Thinking-mode toggle for reasoning models that expose an explicit
	 * on/off control (DeepSeek v4, certain Anthropic profiles, etc.).
	 * Forwarded to the provider request body under the `thinking` key.
	 *
	 * ```toml
	 * [covel.story.thinking]
	 * type = "enabled"
	 * ```
	 */
	thinking: z
		.object({ type: z.enum(["enabled", "disabled"]) })
		.passthrough()
		.optional(),
	/**
	 * Reasoning effort level. Forwarded as `reasoning_effort`.
	 *
	 * ```toml
	 * [covel.story]
	 * reasoning_effort = "high"
	 * ```
	 */
	reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
	/**
	 * Freeform provider request metadata. Merged into every LLM call's
	 * body for this slot (with per-call metadata taking precedence). Use
	 * for provider-specific flags that don't have a dedicated schema
	 * field yet (DashScope `enable_thinking`, OpenRouter routing hints,
	 * etc.).
	 *
	 * ```toml
	 * [covel.story.providerRequestMetadata]
	 * enable_thinking = true
	 * ```
	 */
	providerRequestMetadata: z.record(z.string(), z.unknown()).optional(),
});

export type SlotDefinition = z.infer<typeof slotDefinitionSchema>;

/**
 * Root schema for llm.toml.
 *
 * ```toml
 * [covel.main]
 * provider = "deepseek"
 * ...
 *
 * [covel.fast]
 * provider = "dashscope"
 * ...
 * ```
 */
export const llmConfigSchema = z.object({
	covel: z
		.record(z.string(), slotDefinitionSchema)
		.refine((covel) => Object.keys(covel).length > 0, {
			message: "llm.toml must define at least one slot",
		}),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;
