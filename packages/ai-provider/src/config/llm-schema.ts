import { z } from "zod";
import {
  DEFAULT_PROVIDER_PROTOCOL,
  getBuiltinProviderConnection,
  isProviderProtocolId,
} from "@covel/shared";
import { REASONING_EFFORT_VALUES } from "../reasoning-effort.js";

/**
 * A built-in protocol, or `<pluginId>/<wireId>` for a text protocol a plugin
 * registers. The plugin loads after this file, so an ID of that form is
 * checked when a call resolves it.
 */
export const providerProtocolSchema = z.string().refine(isProviderProtocolId, {
  error:
    "Unknown protocol: use a built-in protocol ID, or <pluginId>/<wireId> for a plugin's text protocol",
});

const inputModalitySchema = z.enum(["text", "image", "audio", "video", "file"]);
const outputModalitySchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "embedding",
  "evaluation",
]);
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
    cacheReadPerMToken: z.number().nonnegative().optional(),
    cacheWritePerMToken: z.number().nonnegative().optional(),
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
 * # A built-in provider (`BUILTIN_PROVIDER_CONNECTIONS`) may omit `baseUrl`
 * # and `protocol`; any provider may omit `protocol` for OpenAI Chat.
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
const slotFieldsSchema = z.object({
  /** Provider identifier — maps to {PROVIDER}_API_KEY in .env.llm */
  provider: z.string().min(1),
  /** Model ID passed to the provider API */
  model: z.string().min(1),
  /** API endpoint URL. Optional for a built-in provider. */
  baseUrl: z.string().url().optional(),
  /** Wire protocol. Default: the built-in provider's, else OpenAI Chat. */
  protocol: providerProtocolSchema.optional(),
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

  // ── Thinking control (optional) ──────────────────────────────────

  /**
   * Portable thinking control for every call on this slot, in the spirit of
   * the AI SDK's top-level `reasoning` option. The adapter translates it per
   * provider (`enable_thinking` for Qwen, `thinking.type` for DeepSeek and
   * Anthropic, `reasoning_effort` for OpenAI, `thinkingConfig` for Gemini).
   * `disabled` turns thinking off; `provider-default` leaves it to the
   * provider. It is the model default: an explicit role override beats it,
   * and it beats a runtime's own default. A value the model does not support
   * reports a warning and keeps the provider default. Native fields belong
   * in `providerOptions` or `providerRequestMetadata`.
   *
   * ```toml
   * [covel.story]
   * reasoningEffort = "disabled"
   * ```
   */
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
  reasoning_effort: z
    .never({ error: "`reasoning_effort` is now `reasoningEffort`" })
    .optional(),
  thinking: z
    .never({
      error:
        "`thinking` is now the portable `reasoningEffort`; put native fields in `providerOptions`",
    })
    .optional(),
  /**
   * Freeform provider request metadata. Merged into every LLM call's
   * body for this slot (with per-call metadata taking precedence). Use
   * for provider-specific flags that don't have a dedicated schema
   * field yet (OpenRouter routing hints, media wire keys, etc.).
   *
   * ```toml
   * [covel.story.providerRequestMetadata]
   * enable_thinking = true
   * ```
   */
  providerRequestMetadata: z.record(z.string(), z.unknown()).optional(),
  /** Namespaced settings; the active provider/protocol validates its own options. */
  providerOptions: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
});

/** Every parsed slot states its endpoint and protocol. */
const slotDefinitionSchema = slotFieldsSchema.transform((def, ctx) => {
  const known = getBuiltinProviderConnection(def.provider);
  const baseUrl = def.baseUrl ?? known?.baseUrl;
  if (!baseUrl) {
    ctx.addIssue({
      code: "custom",
      path: ["baseUrl"],
      message: `baseUrl is required: "${def.provider}" is not a built-in provider`,
    });
    return z.NEVER;
  }
  return {
    ...def,
    baseUrl,
    protocol: def.protocol ?? known?.protocol ?? DEFAULT_PROVIDER_PROTOCOL,
  };
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
