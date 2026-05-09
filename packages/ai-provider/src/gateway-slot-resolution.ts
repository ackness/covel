import type { ProviderDefaults } from "./types.js";
import type { ProviderResolution } from "./provider-registry.js";
import type { SlotRegistry } from "./slot-registry.js";
import { applySlotOverlay, resolveSlotOverride } from "./slot-overlay.js";
import { targetModel, targetProvider } from "./gateway-lifecycle.js";
import type {
  ModelParameterOverrides,
  OperationMode,
  PresetConfig,
  ProviderProtocol,
  ResolvedSlotConfig,
  ResolvedTarget,
  SlotOverridesInput,
} from "./types.js";

export interface GatewaySlotResolutionDependencies {
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
    hasProvider?(name: string): boolean;
    addProvider?(name: string, defaults: ProviderDefaults): void;
    removeProvider?(name: string): void;
  };
  presetRegistry: {
    resolveTextTarget(input: { presetId?: string }): ResolvedTarget;
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

export interface GatewaySlotResolution {
  resolveSlotOrPassthrough(
    presetId: string | undefined,
    fallbackTag?: string,
    options?: GatewayOptions,
  ): string | undefined;
  resolveSlotToPresetId(slotId: string): string | undefined;
  getSlotParameterOverrides(
    slotId: string,
  ): ModelParameterOverrides | undefined;
  resolveParameterOverrides(
    presetId: string | undefined,
    options: GatewayOptions | undefined,
  ): ModelParameterOverrides | undefined;
  withParameterOverrides(
    metadata: Record<string, unknown> | undefined,
    presetId: string | undefined,
    options: GatewayOptions | undefined,
  ): Record<string, unknown> | undefined;
  withPresetMetadata(
    target: ResolvedTarget,
    metadata: Record<string, unknown> | undefined,
    presetId: string | undefined,
    options: GatewayOptions | undefined,
  ): Record<string, unknown> | undefined;
  resolveSlot(
    presetId: string | undefined,
    options?: GatewayOptions & { fallbackTag?: string },
  ): ResolvedSlotConfig | null;
}

export function createGatewaySlotResolution(
  deps: GatewaySlotResolutionDependencies,
  warnedFallbacks: Set<string>,
): GatewaySlotResolution {
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
    resolveSlotOrPassthrough,
    resolveSlotToPresetId,
    getSlotParameterOverrides,
    resolveParameterOverrides,
    withParameterOverrides,
    withPresetMetadata,
    resolveSlot,
  };
}
