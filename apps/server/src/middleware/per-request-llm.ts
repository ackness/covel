/**
 * Per-request LLM adapter middleware.
 *
 * Parses the two request-scoped configuration headers sent by the
 * browser:
 *
 *   - `X-Provider-Keys`  base64 JSON  →  `{ [provider]: apiKey }`
 *   - `X-Slot-Config`    base64 JSON  →  slot, parameter, preset, and operational capability overlays
 *
 * and, when either is present, swaps `c.get('llmAdapter')` for a
 * request-scoped adapter that forwards these through the gateway. This
 * lets browser-only custom slots (e.g. `covel.fast`) participate in
 * real turn execution instead of silently falling back to the first
 * text slot configured in llm.toml.
 *
 * Keys are never written to disk or process memory beyond the scope of
 * a single request. API keys provided by the browser win over any
 * server-side environment keys so the UI can override per session.
 *
 * Env keys are passed to the gateway separately (`envApiKeys`) from the
 * browser-supplied keys (`apiKeys`): the provider registry only attaches
 * an env key when the resolved target's baseUrl origin matches trusted
 * server config, so a request-scoped custom preset that redirects a
 * built-in provider to a foreign origin can never exfiltrate a server
 * key.
 *
 * When neither header is present the middleware is a no-op and the
 * base-startup `llmAdapter` stays in place.
 */

import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  createGatewayAdapter,
  createPluginRuntimeGateway,
} from "@covel/runtime";
import type { AiStack } from "../ai-setup.js";
import type { SlotOverridesInput } from "@covel/ai-provider";
import {
  PROVIDER_PROTOCOLS,
  REASONING_EFFORT_VALUES,
} from "@covel/ai-provider";
import type { PluginRuntimeGateway } from "@covel/plugin-loader";
import { decodeBase64Json } from "../lib/base64-json.js";
import { llmModelBindingSchema, readRuntimeEnv } from "@covel/shared";

export interface PerRequestLlmOptions {
  readonly ai: AiStack;
  /** Base API keys from process.env (*_API_KEY). Client keys override. */
  readonly envApiKeys: Record<string, string>;
  /**
   * The adapter produced at server startup. Used as a fallback when the
   * request has no overriding headers so callers can keep relying on
   * `c.get('llmAdapter')` without null checks.
   */
  readonly defaultLlmAdapter: import("@covel/runtime").LLMAdapter;
  /**
   * The plugin-runtime gateway facade produced at server startup. When the
   * request carries overriding headers the middleware rebuilds a request-
   * scoped facade so function-runtime `ctx.gateway.resolveSlot(...)` /
   * `generateText(...)` calls honour the same browser-supplied provider
   * keys / custom presets / slot overrides as the agent-runtime LLM
   * adapter. Without this rebuild the function-runtime path silently uses
   * the startup env keys and the server-side llm.toml, defeating
   * per-session UI settings.
   */
  readonly defaultPluginGateway: PluginRuntimeGateway;
}

const MAX_HEADER_BYTES = 64 * 1024; // sanity cap — browsers rarely send bigger
const MAX_CONTEXT_WINDOW = 10_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const INPUT_MODALITIES = new Set(["text", "image", "audio", "video", "file"]);
const OUTPUT_MODALITIES = new Set([
  "text",
  "image",
  "audio",
  "video",
  "embedding",
  "evaluation",
]);
const MODEL_FEATURES = new Set([
  "function_calling",
  "structured_output",
  "streaming",
  "reasoning",
  "vision",
  "prompt_caching",
  "web_search",
  "computer_use",
]);

export function createPerRequestLlmMiddleware(
  opts: PerRequestLlmOptions,
): MiddlewareHandler {
  return async (c, next) => {
    const requestKeys = parseProviderKeys(c.req.header("X-Provider-Keys"));
    const slotHeader = c.req.header("X-Slot-Config");
    const slotOverrides = parseSlotOverrides(slotHeader);
    if (slotHeader !== undefined && slotOverrides === null) {
      return c.json(
        {
          error: "Invalid model configuration",
          code: "invalid_llm_configuration",
        },
        400,
      );
    }
    const capabilityOverridePolicy =
      readRuntimeEnv().deploymentTier === "self" ? "full" : "restrict-only";

    const hasRequestKeys =
      requestKeys !== null && Object.keys(requestKeys).length > 0;
    const hasOverrides =
      slotOverrides !== null &&
      ((slotOverrides.customPresets?.length ?? 0) > 0 ||
        Object.keys(slotOverrides.parameterOverrides ?? {}).length > 0 ||
        Object.keys(slotOverrides.slotBindings ?? {}).length > 0 ||
        Object.keys(slotOverrides.capabilityOverrides ?? {}).length > 0);

    if (!hasRequestKeys && !hasOverrides) {
      await next();
      return;
    }

    const perRequestAdapter = createGatewayAdapter(opts.ai.gateway, {
      apiKeys: requestKeys ?? {},
      envApiKeys: opts.envApiKeys,
      ...(slotOverrides ? { slotOverrides } : {}),
      capabilityOverridePolicy,
    });

    // Keep the function-runtime gateway in lock-step with the
    // agent-runtime LLM adapter. Both are rebuilt from the same merged
    // keys / slot overrides so `ctx.gateway.resolveSlot(...)` inside a
    // function handler resolves the same browser-declared custom presets
    // (e.g. a user-added DashScope preset for image plugins) as the
    // agent-runtime side sees via `llmAdapter`.
    const perRequestPluginGateway = createPluginRuntimeGateway(
      opts.ai.gateway,
      {
        apiKeys: requestKeys ?? {},
        envApiKeys: opts.envApiKeys,
        ...(slotOverrides ? { slotOverrides } : {}),
        capabilityOverridePolicy,
      },
    );

    c.set("llmAdapter", perRequestAdapter);
    c.set("pluginGateway", perRequestPluginGateway);
    c.set("requestLlmOverridden", true);
    if (slotOverrides?.slotBindings?.memory) {
      c.set("requestMemorySlot", "memory");
    }
    await next();
  };
}

export function parseProviderKeys(
  header: string | undefined,
): Record<string, string> | null {
  if (!header || header.length > MAX_HEADER_BYTES) return null;
  const parsed = decodeBase64Json(header);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) result[k] = v;
  }
  return result;
}

const publicModelId = z
  .string()
  .min(1)
  .refine((id) => !id.includes("\u0000"));
const slotOverrideEnvelopeSchema = z.strictObject({
  slotBindings: z.record(z.string().min(1), llmModelBindingSchema).optional(),
  parameterOverrides: z.unknown().optional(),
  capabilityOverrides: z.unknown().optional(),
  customPresets: z
    .array(
      z.object({
        id: z.string().trim().pipe(publicModelId),
        name: z.string().optional(),
        provider: z.string().min(1),
        model: z.string().min(1),
        baseUrl: z.string().optional(),
        protocol: z.enum(PROVIDER_PROTOCOLS).optional(),
        reasoningEffort: z
          .enum(REASONING_EFFORT_VALUES)
          .optional()
          .catch(undefined),
      }),
    )
    .optional(),
});

export function parseSlotOverrides(
  header: string | undefined,
): SlotOverridesInput | null {
  if (!header || header.length > MAX_HEADER_BYTES) return null;
  // Defensive try/catch: untrusted browser input parsed across many branches.
  try {
    const decoded = slotOverrideEnvelopeSchema.safeParse(
      decodeBase64Json(header),
    );
    if (!decoded.success) return null;
    const parsed = decoded.data;
    const out: SlotOverridesInput = {};
    if (parsed.slotBindings) out.slotBindings = parsed.slotBindings;
    const paramMap = parsed.parameterOverrides;
    if (paramMap && typeof paramMap === "object" && !Array.isArray(paramMap)) {
      const clean: NonNullable<SlotOverridesInput["parameterOverrides"]> = {};
      for (const [slotId, raw] of Object.entries(
        paramMap as Record<string, unknown>,
      )) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const source = raw as Record<string, unknown>;
        const next: Record<string, number | string> = {};
        for (const key of [
          "temperature",
          "topP",
          "topK",
          "maxOutputTokens",
          "frequencyPenalty",
          "presencePenalty",
        ] as const) {
          const value = source[key];
          if (key === "maxOutputTokens") {
            const output = cleanPositiveInt(value, MAX_OUTPUT_TOKENS);
            if (output !== undefined) next[key] = output;
          } else if (typeof value === "number" && Number.isFinite(value)) {
            next[key] = value;
          }
        }
        const reasoningEffort = source.reasoningEffort;
        if (
          typeof reasoningEffort === "string" &&
          (REASONING_EFFORT_VALUES as readonly string[]).includes(
            reasoningEffort,
          )
        ) {
          next.reasoningEffort = reasoningEffort;
        }
        if (Object.keys(next).length > 0) {
          clean[slotId] = next as NonNullable<
            SlotOverridesInput["parameterOverrides"]
          >[string];
        }
      }
      if (Object.keys(clean).length > 0) out.parameterOverrides = clean;
    }
    const customPresets = parsed.customPresets;
    if (customPresets) {
      const ids = new Set(customPresets.map((preset) => preset.id));
      if (ids.size !== customPresets.length) return null;
      out.customPresets = customPresets.map((preset) => ({
        ...preset,
        name: preset.name ?? preset.id,
      }));
    }
    for (const binding of Object.values(out.slotBindings ?? {})) {
      if (
        binding.modelRef !== undefined &&
        !out.customPresets?.some((p) => p.id === binding.modelRef)
      )
        return null;
    }
    const capabilityMap = (parsed as Record<string, unknown>)
      .capabilityOverrides;
    if (
      capabilityMap &&
      typeof capabilityMap === "object" &&
      !Array.isArray(capabilityMap)
    ) {
      const clean: NonNullable<SlotOverridesInput["capabilityOverrides"]> = {};
      for (const [slotId, raw] of Object.entries(
        capabilityMap as Record<string, unknown>,
      ).slice(0, 64)) {
        if (
          !slotId ||
          slotId.length > 128 ||
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw)
        )
          continue;
        const source = raw as Record<string, unknown>;
        const next: NonNullable<
          SlotOverridesInput["capabilityOverrides"]
        >[string] = {};
        const input = cleanStringArray(source.input, INPUT_MODALITIES, false);
        const output = cleanStringArray(
          source.output,
          OUTPUT_MODALITIES,
          false,
        );
        const features = cleanStringArray(
          source.features,
          MODEL_FEATURES,
          true,
        );
        if (input) next.input = input as typeof next.input;
        if (output) next.output = output as typeof next.output;
        if (features) next.features = features as typeof next.features;
        const contextWindow = cleanPositiveInt(
          source.contextWindow,
          MAX_CONTEXT_WINDOW,
        );
        const maxOutputTokens = cleanPositiveInt(
          source.maxOutputTokens,
          MAX_OUTPUT_TOKENS,
        );
        if (contextWindow !== undefined) next.contextWindow = contextWindow;
        if (maxOutputTokens !== undefined)
          next.maxOutputTokens = maxOutputTokens;
        // `pricing` is deliberately ignored: request callers cannot assert
        // accounting facts used by a shared host.
        if (Object.keys(next).length > 0) clean[slotId] = next;
      }
      if (Object.keys(clean).length > 0) out.capabilityOverrides = clean;
    }
    return out;
  } catch {
    return null;
  }
}

function cleanPositiveInt(value: unknown, max: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= max
    ? value
    : undefined;
}

function cleanStringArray(
  value: unknown,
  allowed: ReadonlySet<string>,
  allowEmpty: boolean,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean = [
    ...new Set(value.filter((item) => typeof item === "string")),
  ].filter((item) => allowed.has(item));
  if (!allowEmpty && clean.length === 0) return undefined;
  return clean;
}
