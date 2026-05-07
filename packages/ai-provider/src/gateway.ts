import type { ZodType } from "zod";

import { AiProviderError } from "./errors.js";
import type { ProviderDefaults } from "./types.js";
import type { ProviderResolution } from "./provider-registry.js";
import type { SlotRegistry } from "./slot-registry.js";
import { applySlotOverlay, resolveSlotOverride } from "./slot-overlay.js";
import type {
  EmbeddingResult,
  ModelParameterOverrides,
  OperationMode,
  PresetConfig,
  ProviderConfig,
  ProviderLifecycleHook,
  ProviderProtocol,
  ResolvedSlotConfig,
  ResolvedTarget,
  SlotOverridesInput,
  SpeechSynthesisResult,
  StreamEvent,
  TextMessage,
  ToolDefinition,
  TranscriptionResult,
  UsageSummary,
} from "./types.js";

interface GatewayDependencies {
  providerRegistry: {
    resolve(
      target: {
        provider: string;
        baseUrl?: string;
        protocol?: ProviderProtocol;
      },
      options?: { mode: OperationMode },
    ): ProviderResolution;
    withApiKeys(
      resolution: ProviderResolution,
      apiKeys: Record<string, string>,
      providerName: string,
    ): ProviderResolution;
    // Overlay-capable methods — populated by the real createProviderRegistry.
    // Optional so structural test mocks don't need to implement them; when
    // absent, slotOverrides simply silently degrade to no-op.
    hasProvider?(name: string): boolean;
    addProvider?(name: string, defaults: ProviderDefaults): void;
    removeProvider?(name: string): void;
  };
  presetRegistry: {
    resolveTextTarget(input: { presetId?: string }): ResolvedTarget;
    resolveEmbeddingTarget(input?: { presetId?: string }): ResolvedTarget;
    resolveTextTargetChain(input: { presetId?: string }): ResolvedTarget[];
    hasPreset?(id: string): boolean;
    addPreset?(preset: PresetConfig): void;
    removePreset?(id: string): void;
  };
  slotRegistry?: SlotRegistry;
}

export interface GatewayOptions {
  /** Runtime API keys from request header. */
  apiKeys?: Record<string, string>;
  /** Trace ID for observability. */
  traceId?: string;
  /** Slot-level parameter overrides resolved from the slot registry. */
  parameterOverrides?: ModelParameterOverrides;
  /** Abort signal for cancellation (e.g. budget timeout). */
  signal?: AbortSignal;
  /**
   * Per-request overlay that transiently extends the gateway's preset /
   * provider / slot view. Populated by server middleware from the
   * `X-Slot-Config` header so browser-only custom slots propagate into
   * real LLM calls. See {@link SlotOverridesInput}.
   */
  slotOverrides?: SlotOverridesInput;
}

/**
 * Create the high-level AI gateway.
 *
 * Provides 7 operations with automatic fallback routing for text operations.
 */
export function createGateway(deps: GatewayDependencies) {
  /**
   * Tracks which (slot, fallbackTag) pairs we've already warned about so a
   * misconfigured runtime doesn't spam stderr every turn. The set lives in
   * gateway closure — reset on server restart.
   */
  const warnedFallbacks = new Set<string>();

  /**
   * Resolve a slot name to its preset ID.
   *
   * If the slot isn't configured, fall back to the first registered slot
   * whose tag matches `fallbackTag`. This lets minimal configs (e.g. only
   * a `story` slot defined) serve every plugin that asks for `plugin`,
   * `fast`, `balance`, etc. — the user gets a warning once per unknown
   * slot so they can add the missing entry when they care.
   *
   * Cross-tag fallback is intentionally disabled: a slot asking for `image`
   * never silently falls through to a text slot.
   *
   * Returns the original slotId when no fallback is possible; callers keep
   * their existing error paths (preset-registry will throw "preset not
   * found" so the failure is explicit).
   */
  function resolveSlotOrPassthrough(
    presetId: string | undefined,
    fallbackTag: string = "text",
    options?: GatewayOptions,
  ): string | undefined {
    if (!presetId) return presetId;

    // Per-request client override takes highest precedence. When the slot
    // name matches a key in `slotPresetOverrides` we treat the result as
    // an already-resolved preset id and short-circuit — skipping the
    // slot-registry lookup prevents the tag-based fallback from silently
    // routing a browser-only slot name (e.g. "fast") to the first
    // llm.toml slot (e.g. "story").
    const clientOverride = resolveSlotOverride(
      presetId,
      options?.slotOverrides,
    );
    if (clientOverride !== presetId) return clientOverride;

    // Direct preset-id match trumps the slot lookup. Without this the
    // tag-based fallback below would divert calls made with a raw preset
    // id (e.g. a browser-registered `custom_abc`) into the first
    // same-tag slot, silently swapping the target model.
    if (deps.presetRegistry.hasPreset?.(presetId)) return presetId;

    if (!deps.slotRegistry) return presetId;

    const direct = deps.slotRegistry.resolveSlot(presetId);
    if (direct) return direct;

    const candidates = deps.slotRegistry.listSlotsByTag(fallbackTag);
    if (candidates.length === 0) return presetId;

    const fallback = candidates[0];
    const key = `${presetId}→${fallback.slotId}`;
    if (!warnedFallbacks.has(key)) {
      warnedFallbacks.add(key);
      console.warn(
        `[ai-gateway] slot "${presetId}" not configured; falling back to "${fallback.slotId}" ` +
          `(same tag="${fallbackTag}"). Add [covel.${presetId}] to llm.toml to silence.`,
      );
    }
    return fallback.presetId;
  }

  async function generateText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ) {
    return runWithFallback(
      { presetId: input.presetId },
      "text",
      options,
      async (target, resolved) =>
        resolved.adapter.generateText(
          configWithSignal(resolved.config, options),
          {
            model: targetModel(target),
            messages: input.messages,
            tools: input.tools,
            providerRequestMetadata: withPresetMetadata(
              target,
              input.providerRequestMetadata,
              input.presetId,
              options,
            ),
          },
          { profile: target.profile, preset: target.preset, mode: "text" },
        ),
      (r) => r.usage,
    );
  }

  async function generateObject<TObject>(
    input: {
      presetId?: string;
      schema: ZodType<TObject>;
      messages: TextMessage[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ) {
    return runWithFallback(
      { presetId: input.presetId },
      "object",
      options,
      async (target, resolved) => {
        const result = await resolved.adapter.generateObject(
          configWithSignal(resolved.config, options),
          {
            model: targetModel(target),
            schema: input.schema,
            messages: input.messages,
            providerRequestMetadata: withPresetMetadata(
              target,
              input.providerRequestMetadata,
              input.presetId,
              options,
            ),
          },
          { profile: target.profile, preset: target.preset, mode: "object" },
        );
        return result as {
          object: TObject;
          finishReason: string;
          usage: UsageSummary;
        };
      },
      (r) => r.usage,
    );
  }

  async function* streamText(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): AsyncIterable<StreamEvent> {
    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      yield* streamTextInner(input, options);
    } finally {
      cleanup();
    }
  }

  async function* streamTextInner(
    input: {
      presetId?: string;
      messages: TextMessage[];
      tools?: ToolDefinition[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): AsyncIterable<StreamEvent> {
    const targets = deps.presetRegistry.resolveTextTargetChain({
      presetId: resolveSlotOrPassthrough(input.presetId, "text", options),
    });
    let lastError: AiProviderError | null = null;

    for (const [index, target] of targets.entries()) {
      const provider = targetProvider(target);
      let resolved = deps.providerRegistry.resolve(
        target.preset ?? target.profile,
        { mode: "stream" },
      );
      if (options?.apiKeys) {
        resolved = deps.providerRegistry.withApiKeys(
          resolved,
          options.apiKeys,
          provider,
        );
      }

      let emittedDelta = false;
      const startTime = Date.now();

      try {
        await notifyStart(
          resolved.hooks,
          provider,
          resolved.protocol,
          "stream",
          targetModel(target),
          options?.traceId,
        );
        let finalUsage: UsageSummary | null = null;

        for await (const event of resolved.adapter.streamText(
          configWithSignal(resolved.config, options),
          {
            model: targetModel(target),
            messages: input.messages,
            tools: input.tools,
            providerRequestMetadata: withPresetMetadata(
              target,
              input.providerRequestMetadata,
              input.presetId,
              options,
            ),
          },
          { profile: target.profile, preset: target.preset, mode: "stream" },
        )) {
          if (
            (event.type === "text-delta" && event.textDelta.length > 0) ||
            (event.type === "reasoning-delta" &&
              event.reasoningDelta.length > 0)
          ) {
            emittedDelta = true;
          }
          if (event.type === "done") finalUsage = event.usage;
          yield event;
        }

        await notifySuccess(
          resolved.hooks,
          provider,
          resolved.protocol,
          "stream",
          targetModel(target),
          finalUsage,
          Date.now() - startTime,
          options?.traceId,
        );
        return;
      } catch (error) {
        await notifyError(
          resolved.hooks,
          provider,
          resolved.protocol,
          "stream",
          targetModel(target),
          error,
          Date.now() - startTime,
          options?.traceId,
        );
        const normalized = normalizeError(error, provider);
        lastError = normalized;

        if (
          emittedDelta ||
          index === targets.length - 1 ||
          !shouldFallback(normalized)
        ) {
          throw normalized;
        }
      }
    }

    if (lastError) throw lastError;
  }

  async function embed(
    input: {
      presetId?: string;
      values: string[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): Promise<EmbeddingResult> {
    if (!input.values?.length) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        message: "embed() requires at least one value",
        provider: "unknown",
        retriable: false,
      });
    }

    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      return await embedInner(input, options);
    } finally {
      cleanup();
    }
  }

  async function embedInner(
    input: {
      presetId?: string;
      values: string[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): Promise<EmbeddingResult> {
    const target = deps.presetRegistry.resolveEmbeddingTarget({
      presetId: resolveSlotOrPassthrough(input.presetId, "embedding", options),
    });

    // Route via the preset (carries baseUrl/protocol) when available, else
    // via the embed profile's provider name — the provider registry fills
    // in baseUrl/protocol from its registered provider defaults.
    const routingTarget = target.preset ?? {
      provider: target.profile.provider,
    };
    let resolved = deps.providerRegistry.resolve(routingTarget, {
      mode: "embed",
    });
    if (options?.apiKeys) {
      resolved = deps.providerRegistry.withApiKeys(
        resolved,
        options.apiKeys,
        target.profile.provider,
      );
    }

    // Merge slot-level embeddingFormat into the per-call metadata so the
    // adapter can dispatch (e.g. Nemotron multimodal wrapping).
    const providerRequestMetadata: Record<string, unknown> = {
      ...(target.preset?.embeddingFormat !== undefined
        ? { embeddingFormat: target.preset.embeddingFormat }
        : {}),
      ...input.providerRequestMetadata,
    };

    return runSingle(target, "embed", resolved, options, async () =>
      resolved.adapter.embed(
        configWithSignal(resolved.config, options),
        {
          model: target.profile.model,
          values: input.values,
          providerRequestMetadata,
        },
        { profile: target.profile, preset: target.preset, mode: "embed" },
      ),
    );
  }

  async function synthesizeSpeech(
    input: {
      presetId?: string;
      text: string;
      voice?: string;
      format?: string;
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): Promise<SpeechSynthesisResult> {
    return runSingleFromPreset(
      input.presetId,
      "speech",
      options,
      (target, resolved) =>
        resolved.adapter.synthesizeSpeech(
          configWithSignal(resolved.config, options),
          {
            model: targetModel(target),
            text: input.text,
            ...(input.voice ? { voice: input.voice } : {}),
            ...(input.format ? { format: input.format } : {}),
            providerRequestMetadata: input.providerRequestMetadata,
          },
          { profile: target.profile, preset: target.preset, mode: "speech" },
        ),
    );
  }

  async function transcribeAudio(
    input: {
      presetId?: string;
      audio: { data: Uint8Array; mimeType: string; fileName?: string };
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: GatewayOptions,
  ): Promise<TranscriptionResult> {
    return runSingleFromPreset(
      input.presetId,
      "transcription",
      options,
      (target, resolved) =>
        resolved.adapter.transcribeAudio(
          configWithSignal(resolved.config, options),
          {
            model: targetModel(target),
            audio: input.audio,
            providerRequestMetadata: input.providerRequestMetadata,
          },
          {
            profile: target.profile,
            preset: target.preset,
            mode: "transcription",
          },
        ),
    );
  }

  /**
   * Resolve a slot ID to a preset ID via the slot registry.
   * Returns undefined if no slot registry is configured or slot cannot be resolved.
   */
  function resolveSlotToPresetId(slotId: string): string | undefined {
    return deps.slotRegistry?.resolveSlot(slotId);
  }

  /**
   * Get parameter overrides for a given slot ID.
   */
  function getSlotParameterOverrides(
    slotId: string,
  ): ModelParameterOverrides | undefined {
    return deps.slotRegistry?.getParameterOverrides(slotId);
  }

  function resolveParameterOverrides(
    presetId: string | undefined,
    options: GatewayOptions | undefined,
  ): ModelParameterOverrides | undefined {
    if (options?.parameterOverrides) return options.parameterOverrides;
    if (!presetId) return undefined;
    const requestScoped =
      options?.slotOverrides?.parameterOverrides?.[presetId];
    if (requestScoped) return requestScoped;
    return getSlotParameterOverrides(presetId);
  }

  function withParameterOverrides(
    metadata: Record<string, unknown> | undefined,
    presetId: string | undefined,
    options: GatewayOptions | undefined,
  ): Record<string, unknown> | undefined {
    const parameterOverrides = resolveParameterOverrides(presetId, options);
    if (!metadata && !parameterOverrides) return metadata;
    return {
      ...metadata,
      ...(parameterOverrides ? { parameterOverrides } : {}),
    };
  }

  /**
   * Fold the preset's slot-wide `providerRequestMetadata` (thinking mode,
   * reasoning_effort, freeform provider flags) into the per-call metadata.
   *
   * Precedence: preset defaults < per-call metadata < parameterOverrides.
   * Per-call values always win so callers can override the TOML defaults.
   */
  function withPresetMetadata(
    target: ResolvedTarget,
    metadata: Record<string, unknown> | undefined,
    presetId: string | undefined,
    options: GatewayOptions | undefined,
  ): Record<string, unknown> | undefined {
    const presetMeta = target.preset?.providerRequestMetadata;
    const merged =
      presetMeta || metadata ? { ...presetMeta, ...metadata } : undefined;
    return withParameterOverrides(merged, presetId, options);
  }

  /**
   * Resolve a slot/preset id into a public, immutable configuration view
   * suitable for plugin-side wire calls.
   *
   * Plugins that own their own image/audio/custom wire format use this in
   * preference to the high-level helpers (`generateImage`, `embed`, …):
   * the framework picks the right preset, applies request-scoped
   * overlays + API keys, and hands back `{ baseUrl, apiKey, model, … }`
   * without forcing the call through a built-in adapter. The plugin
   * decides whether to use Vercel AI SDK, the OpenAI SDK, raw fetch, a
   * custom polling state machine, etc.
   *
   * Returns `null` when no slot can be resolved (typical when llm.toml is
   * empty AND no per-request override applies). Throws when the preset
   * registry rejects the resolved id (e.g. malformed config).
   */
  function resolveSlot(
    presetId: string | undefined,
    options?: GatewayOptions & { fallbackTag?: string },
  ): ResolvedSlotConfig | null {
    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      const tag = options?.fallbackTag ?? "text";
      const effectivePresetId = resolveSlotOrPassthrough(
        presetId,
        tag,
        options,
      );
      if (!effectivePresetId) return null;

      const target = deps.presetRegistry.resolveTextTarget({
        presetId: effectivePresetId,
      });
      let resolved = deps.providerRegistry.resolve(
        target.preset ?? target.profile,
        { mode: tag === "image" ? "image" : "text" },
      );
      if (options?.apiKeys) {
        resolved = deps.providerRegistry.withApiKeys(
          resolved,
          options.apiKeys,
          targetProvider(target),
        );
      }

      const provider = targetProvider(target);
      const model = targetModel(target);
      const protocol = target.preset?.protocol ?? resolved.protocol;
      const baseUrl = resolved.config.baseUrl ?? target.preset?.baseUrl;
      const presetTag = target.preset?.tag ?? "text";
      const presetMeta = target.preset?.providerRequestMetadata ?? {};
      const parameterOverrides = resolveParameterOverrides(presetId, options);

      // Surface llm.toml's free-form fields (embeddingFormat + any future
      // per-slot hints) under a single `metadata` bag the plugin owns.
      // This is the contract that lets new plugin formats declare bespoke
      // slot fields without framework changes.
      const metadata: Record<string, unknown> = {
        ...presetMeta,
        ...(target.preset?.embeddingFormat !== undefined
          ? { embeddingFormat: target.preset.embeddingFormat }
          : {}),
      };

      return {
        presetId: effectivePresetId,
        provider,
        protocol: protocol as string,
        ...(baseUrl ? { baseUrl } : {}),
        ...(resolved.config.apiKey ? { apiKey: resolved.config.apiKey } : {}),
        ...(resolved.config.headers
          ? { headers: { ...resolved.config.headers } }
          : {}),
        model,
        tag: presetTag,
        metadata,
        ...(parameterOverrides ? { parameterOverrides } : {}),
      };
    } finally {
      cleanup();
    }
  }

  return {
    generateText,
    generateObject,
    streamText,
    embed,
    synthesizeSpeech,
    transcribeAudio,
    resolveSlotToPresetId,
    getSlotParameterOverrides,
    resolveSlot,
  };

  // ── Internal helpers ─────────────────────────────────────────────

  /** Merge abort signal from gateway options into provider config. */
  function configWithSignal(
    config: ProviderConfig,
    options?: GatewayOptions,
  ): ProviderConfig {
    return options?.signal ? { ...config, signal: options.signal } : config;
  }

  async function runWithFallback<TResult>(
    input: { presetId?: string },
    mode: "text" | "object",
    options: GatewayOptions | undefined,
    execute: (
      target: ResolvedTarget,
      resolved: ProviderResolution,
    ) => Promise<TResult>,
    resolveUsage: (result: TResult) => UsageSummary | null,
  ): Promise<TResult> {
    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      return await runWithFallbackInner(
        input,
        mode,
        options,
        execute,
        resolveUsage,
      );
    } finally {
      cleanup();
    }
  }

  async function runWithFallbackInner<TResult>(
    input: { presetId?: string },
    mode: "text" | "object",
    options: GatewayOptions | undefined,
    execute: (
      target: ResolvedTarget,
      resolved: ProviderResolution,
    ) => Promise<TResult>,
    resolveUsage: (result: TResult) => UsageSummary | null,
  ): Promise<TResult> {
    const targets = deps.presetRegistry.resolveTextTargetChain({
      presetId: resolveSlotOrPassthrough(input.presetId, "text", options),
    });
    let lastError: AiProviderError | null = null;

    for (const [index, target] of targets.entries()) {
      const provider = targetProvider(target);
      let resolved = deps.providerRegistry.resolve(
        target.preset ?? target.profile,
        { mode },
      );
      if (options?.apiKeys) {
        resolved = deps.providerRegistry.withApiKeys(
          resolved,
          options.apiKeys,
          provider,
        );
      }

      const startTime = Date.now();

      try {
        await notifyStart(
          resolved.hooks,
          provider,
          resolved.protocol,
          mode,
          targetModel(target),
          options?.traceId,
        );
        const result = await execute(target, resolved);
        await notifySuccess(
          resolved.hooks,
          provider,
          resolved.protocol,
          mode,
          targetModel(target),
          resolveUsage(result),
          Date.now() - startTime,
          options?.traceId,
        );
        return result;
      } catch (error) {
        await notifyError(
          resolved.hooks,
          provider,
          resolved.protocol,
          mode,
          targetModel(target),
          error,
          Date.now() - startTime,
          options?.traceId,
        );
        const normalized = normalizeError(error, provider);
        lastError = normalized;

        if (index === targets.length - 1 || !shouldFallback(normalized)) {
          throw normalized;
        }
      }
    }

    throw (
      lastError ??
      new AiProviderError({
        code: "PROVIDER_ERROR",
        message: "No model target resolved.",
        provider: "unknown",
        retriable: false,
      })
    );
  }

  async function runSingleFromPreset<TResult>(
    presetId: string | undefined,
    mode: OperationMode,
    options: GatewayOptions | undefined,
    execute: (
      target: ResolvedTarget,
      resolved: ProviderResolution,
    ) => Promise<TResult>,
    fallbackTag?: string,
  ): Promise<TResult> {
    const cleanup = applySlotOverlay(deps, options?.slotOverrides);
    try {
      // Map mode → default fallback tag when the caller didn't pick one.
      // image/audio/speech operations must NOT silently fall back to text.
      const tag =
        fallbackTag ??
        (mode === "image"
          ? "image"
          : mode === "speech" || mode === "transcription"
            ? mode
            : "text");
      const target = deps.presetRegistry.resolveTextTarget({
        presetId: resolveSlotOrPassthrough(presetId, tag, options),
      });
      let resolved = deps.providerRegistry.resolve(
        target.preset ?? target.profile,
        { mode },
      );
      if (options?.apiKeys) {
        resolved = deps.providerRegistry.withApiKeys(
          resolved,
          options.apiKeys,
          targetProvider(target),
        );
      }

      return await runSingle(target, mode, resolved, options, () =>
        execute(target, resolved),
      );
    } finally {
      cleanup();
    }
  }

  async function runSingle<TResult>(
    target: ResolvedTarget,
    mode: OperationMode,
    resolved: ProviderResolution,
    options: GatewayOptions | undefined,
    execute: () => Promise<TResult>,
  ): Promise<TResult> {
    const provider = targetProvider(target);
    const model = targetModel(target);
    const startTime = Date.now();

    try {
      await notifyStart(
        resolved.hooks,
        provider,
        resolved.protocol,
        mode,
        model,
        options?.traceId,
      );
      const result = await execute();
      await notifySuccess(
        resolved.hooks,
        provider,
        resolved.protocol,
        mode,
        model,
        null,
        Date.now() - startTime,
        options?.traceId,
      );
      return result;
    } catch (error) {
      await notifyError(
        resolved.hooks,
        provider,
        resolved.protocol,
        mode,
        model,
        error,
        Date.now() - startTime,
        options?.traceId,
      );
      throw normalizeError(error, provider);
    }
  }
}

// ── Shared utilities ───────────────────────────────────────────────

function targetProvider(t: ResolvedTarget): string {
  return t.preset?.provider ?? t.profile.provider;
}

function targetModel(t: ResolvedTarget): string {
  return t.preset?.model ?? t.profile.model;
}

function shouldFallback(error: AiProviderError): boolean {
  // Never fallback on client errors (4xx) — the request itself is malformed,
  // so retrying with a different provider will produce the same failure.
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }
  return error.code === "RATE_LIMITED" || error.code === "PROVIDER_ERROR";
}

function normalizeError(error: unknown, provider: string): AiProviderError {
  if (error instanceof AiProviderError) return error;

  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as {
        code?: string;
        provider?: string;
        retriable?: boolean;
        statusCode?: number;
        details?: Record<string, unknown>;
      };
      if (parsed.code && parsed.provider) {
        // Build a human-readable message that includes API error details
        const detailMsg = parsed.details
          ? ` — ${typeof parsed.details.message === "string" ? parsed.details.message : JSON.stringify(parsed.details)}`
          : "";
        return new AiProviderError({
          code: parsed.code as AiProviderError["code"],
          message: `[${parsed.provider}] HTTP ${parsed.statusCode ?? "?"}${detailMsg}`,
          provider: parsed.provider,
          retriable: Boolean(parsed.retriable),
          statusCode: parsed.statusCode,
          details: parsed.details,
        });
      }
    } catch {
      // Not a JSON error message
    }
  }

  return new AiProviderError({
    code: "PROVIDER_ERROR",
    message: error instanceof Error ? error.message : "Unknown provider error.",
    provider,
    retriable: false,
    cause: error,
  });
}

async function notifyStart(
  hooks: ProviderLifecycleHook[],
  provider: string,
  protocol: ProviderProtocol,
  mode: OperationMode,
  model: string,
  traceId?: string,
) {
  for (const hook of hooks) {
    try {
      await hook.onRequestStart?.({ provider, protocol, mode, model, traceId });
    } catch (err) {
      console.warn(
        `[ai-provider] Hook onRequestStart failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

async function notifySuccess(
  hooks: ProviderLifecycleHook[],
  provider: string,
  protocol: ProviderProtocol,
  mode: OperationMode,
  model: string,
  usage: UsageSummary | null,
  durationMs: number,
  traceId?: string,
) {
  for (const hook of hooks) {
    try {
      await hook.onRequestSuccess?.({
        provider,
        protocol,
        mode,
        model,
        usage,
        durationMs,
        traceId,
      });
    } catch (err) {
      console.warn(
        `[ai-provider] Hook onRequestSuccess failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

async function notifyError(
  hooks: ProviderLifecycleHook[],
  provider: string,
  protocol: ProviderProtocol,
  mode: OperationMode,
  model: string,
  error: unknown,
  durationMs: number,
  traceId?: string,
) {
  for (const hook of hooks) {
    try {
      await hook.onRequestError?.({
        provider,
        protocol,
        mode,
        model,
        error,
        durationMs,
        traceId,
      });
    } catch (err) {
      console.warn(
        `[ai-provider] Hook onRequestError failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
