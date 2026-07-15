/**
 * Per-request overlay for preset/provider registries.
 *
 * The gateway exposes a single shared preset/provider registry built at
 * server startup from `llm.toml`. Browser users, however, can define
 * custom presets and slot → preset mappings that only live in
 * `localStorage`. To make those definitions actually participate in real
 * LLM calls, each request can carry an overlay (via `X-Slot-Config`)
 * that the gateway applies transiently: register the declared custom
 * presets/providers for the duration of the call, then roll back.
 *
 * Concurrency: module-level reference counts guard against a request
 * removing a registration that another concurrent request is still
 * using. The overlay only tracks entries it introduced — if a preset or
 * provider already exists in the base registry it is left untouched on
 * both apply and cleanup (overwriting base entries would be racy and
 * easy to footgun).
 */

import type {
  CustomPresetInput,
  PresetConfig,
  ProviderDefaults,
  SlotOverridesInput,
} from "./types.js";

/**
 * Minimal registry surface the overlay needs. Matches the real
 * `createPresetRegistry` / `createProviderRegistry` return types but
 * declared structurally so the gateway (whose dep type is intentionally
 * narrow) can still pass its registries through without a cast.
 *
 * Each method is optional so structural test mocks that don't care about
 * overlays can omit them — the overlay then degrades to a no-op rather
 * than throwing.
 */
export interface OverlayDeps {
  readonly presetRegistry: {
    hasPreset?(id: string): boolean;
    addPreset?(preset: PresetConfig): void;
    removePreset?(id: string): void;
  };
  readonly providerRegistry: {
    hasProvider?(name: string): boolean;
    addProvider?(
      name: string,
      defaults: ProviderDefaults,
      opts?: { requestScoped?: boolean },
    ): void;
    removeProvider?(name: string): void;
  };
}

/** Shared across overlay scopes — the registry is a process-wide singleton. */
const presetRefs = new Map<string, number>();
const providerRefs = new Map<string, number>();

/**
 * Apply a slot overlay to the shared registries.
 *
 * Returns a cleanup function that rolls back the additions made by
 * THIS call — reference-counted so concurrent callers referencing the
 * same preset id don't stomp on each other.
 *
 * The overlay is additive only. It never overwrites entries present in
 * the base registry at the moment the overlay is applied.
 */
export function applySlotOverlay(
  deps: OverlayDeps,
  overrides: SlotOverridesInput | undefined,
): () => void {
  const customPresets = overrides?.customPresets;
  if (!customPresets || customPresets.length === 0) {
    return noop;
  }

  const { hasProvider, addProvider, removeProvider } = deps.providerRegistry;
  const { hasPreset, addPreset, removePreset } = deps.presetRegistry;

  // Registry surface incomplete — silently skip rather than throw. This
  // lets test doubles using minimal structural mocks still drive the
  // gateway without having to implement overlay methods.
  if (!hasProvider || !addProvider || !removeProvider) return noop;
  if (!hasPreset || !addPreset || !removePreset) return noop;

  // Track the ids WE touched so cleanup only decrements refs for them.
  const ownedPresetIds: string[] = [];
  const ownedProviderNames: string[] = [];

  for (const cp of customPresets) {
    if (!isUsableCustomPreset(cp)) continue;

    // Provider registration. Policy:
    //   - If the module-level ref map already tracks this provider, it's
    //     overlay-owned — bump the count and take a reference.
    //   - Else if the base registry has it, leave it alone (never overlay
    //     an llm.toml / process-wide provider).
    //   - Else register it fresh and start counting.
    const providerOverlayOwned = providerRefs.has(cp.provider);
    if (providerOverlayOwned) {
      providerRefs.set(cp.provider, (providerRefs.get(cp.provider) ?? 0) + 1);
      ownedProviderNames.push(cp.provider);
    } else if (!hasProvider.call(deps.providerRegistry, cp.provider)) {
      addProvider.call(
        deps.providerRegistry,
        cp.provider,
        {
          ...(cp.baseUrl ? { baseUrl: cp.baseUrl } : {}),
          ...(cp.protocol ? { protocol: cp.protocol } : {}),
        },
        // Untrusted request origin — env keys must not bind to it (S-01).
        { requestScoped: true },
      );
      providerRefs.set(cp.provider, 1);
      ownedProviderNames.push(cp.provider);
    }

    // Preset registration — same policy as provider.
    const presetOverlayOwned = presetRefs.has(cp.id);
    if (presetOverlayOwned) {
      presetRefs.set(cp.id, (presetRefs.get(cp.id) ?? 0) + 1);
      ownedPresetIds.push(cp.id);
    } else if (!hasPreset.call(deps.presetRegistry, cp.id)) {
      addPreset.call(deps.presetRegistry, {
        id: cp.id,
        name: cp.name || cp.id,
        provider: cp.provider,
        model: cp.model,
        ...(cp.protocol ? { protocol: cp.protocol } : {}),
        ...(cp.baseUrl ? { baseUrl: cp.baseUrl } : {}),
        tier: "medium",
        supportedModes: ["text", "stream"],
        enabled: true,
        tag: "text",
        // Untrusted request origin — env keys must not bind to it (S-01).
        requestScoped: true,
      });
      presetRefs.set(cp.id, 1);
      ownedPresetIds.push(cp.id);
    }
  }

  if (ownedPresetIds.length === 0 && ownedProviderNames.length === 0) {
    return noop;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const id of ownedPresetIds) {
      decrementRef(presetRefs, id, () =>
        removePreset.call(deps.presetRegistry, id),
      );
    }
    for (const name of ownedProviderNames) {
      decrementRef(providerRefs, name, () =>
        removeProvider.call(deps.providerRegistry, name),
      );
    }
  };
}

/**
 * Resolve a requested presetId against per-request slot overrides.
 *
 * If the requested id matches a key in `slotPresetOverrides`, returns
 * the overridden preset id. Otherwise returns the input unchanged so
 * callers can fall through to the base slot registry.
 */
export function resolveSlotOverride(
  presetId: string | undefined,
  overrides: SlotOverridesInput | undefined,
): string | undefined {
  if (!presetId || !overrides?.slotPresetOverrides) return presetId;
  const override = overrides.slotPresetOverrides[presetId];
  if (override && override.length > 0) return override;
  return presetId;
}

function isUsableCustomPreset(cp: CustomPresetInput): boolean {
  return (
    typeof cp.id === "string" &&
    cp.id.length > 0 &&
    typeof cp.provider === "string" &&
    cp.provider.length > 0 &&
    typeof cp.model === "string" &&
    cp.model.length > 0
  );
}

function decrementRef(
  map: Map<string, number>,
  key: string,
  onZero: () => void,
): void {
  const current = map.get(key) ?? 0;
  if (current <= 1) {
    map.delete(key);
    onZero();
  } else {
    map.set(key, current - 1);
  }
}

function noop(): void {
  /* no overlay applied */
}

// Kept re-exported for tests that want to assert zero outstanding refs.
export const __internals = {
  presetRefs,
  providerRefs,
};
