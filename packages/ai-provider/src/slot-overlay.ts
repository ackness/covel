/**
 * Per-request overlay for the preset registry.
 *
 * The gateway exposes a single shared preset/provider registry built at
 * server startup from `llm.toml`. Browser users, however, can define
 * custom presets and slot → preset mappings that only live in
 * `localStorage`. To make those definitions actually participate in real
 * LLM calls, each request can carry an overlay (via `X-Slot-Config`)
 * that the gateway applies transiently: register the declared custom
 * presets for the duration of the call, then roll back.
 *
 * Isolation model: overlay presets are registered under a
 * request-derived scoped id — the canonical (id, provider, model,
 * baseUrl, protocol, name) tuple. Two concurrent requests using the same
 * preset id with DIFFERENT configs therefore never share a registration:
 * each resolves its own scoped id (recomputed from its own overrides via
 * {@link resolveOverlayPresetId}) and can never be routed to a baseUrl it
 * didn't itself declare. Identical configs share one registration,
 * guarded by a reference count so a request removing its overlay never
 * strips a registration another identical request is still using.
 *
 * Providers named by custom presets are intentionally NOT registered at
 * all — the provider registry resolves request-scoped targets ephemerally
 * (see `createProviderRegistry().resolve`), so there is no shared
 * provider state a concurrent request could poison. Entries present in
 * the base registry (llm.toml) are never shadowed: a custom preset whose
 * id matches a base preset resolves to the base preset unchanged.
 */

import type {
  CustomPresetInput,
  PresetConfig,
  SlotOverridesInput,
} from "./types.js";

/**
 * Minimal registry surface the overlay needs. Matches the real
 * `createPresetRegistry` return type but declared structurally so the
 * gateway (whose dep type is intentionally narrow) can still pass its
 * registries through without a cast.
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
}

/**
 * Marker prefix for scoped overlay ids. The leading NUL cannot survive an
 * llm.toml round-trip into a base preset id, so overlay registrations can
 * never be addressed as (or collide with) base entries.
 */
const SCOPE_PREFIX = "\u0000overlay:";

/**
 * Reference counts for overlay-owned scoped preset ids. Shared across
 * overlay scopes — the preset registry is a process-wide singleton, and
 * two requests with byte-identical configs share one registration.
 */
const presetRefs = new Map<string, number>();

/**
 * Scoped registry id for a custom preset: the canonical (id, config)
 * tuple itself, JSON-encoded. Equal tuples ⇔ equal ids — no hash, no
 * delimiter ambiguity (JSON.stringify is injective on this tuple) — which
 * is what makes cross-request sharing safe: sharing is only possible when
 * every routing-relevant field already matches, so a request can never be
 * routed to a baseUrl it didn't itself declare.
 */
function overlayPresetKey(cp: CustomPresetInput): string {
  return (
    SCOPE_PREFIX +
    JSON.stringify([
      cp.id,
      cp.provider,
      cp.model,
      cp.baseUrl ?? null,
      cp.protocol ?? null,
      cp.name ?? null,
    ])
  );
}

/** Map a (possibly scoped) preset id back to its public form for display. */
export function publicPresetId(presetId: string): string {
  if (!presetId.startsWith(SCOPE_PREFIX)) return presetId;
  try {
    const tuple: unknown = JSON.parse(presetId.slice(SCOPE_PREFIX.length));
    if (Array.isArray(tuple) && typeof tuple[0] === "string") return tuple[0];
  } catch {
    /* unparseable scoped id — fall through to the raw id */
  }
  return presetId;
}

/**
 * Apply a slot overlay to the shared preset registry.
 *
 * Returns a cleanup function that rolls back the additions made by
 * THIS call — reference-counted so concurrent callers registering the
 * same (id, config) pair don't stomp on each other.
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

  const { hasPreset, addPreset, removePreset } = deps.presetRegistry;

  // Registry surface incomplete — silently skip rather than throw. This
  // lets test doubles using minimal structural mocks still drive the
  // gateway without having to implement overlay methods.
  if (!hasPreset || !addPreset || !removePreset) return noop;

  // Track the scoped ids WE took a reference on so cleanup only
  // decrements refs for them.
  const ownedPresetKeys: string[] = [];

  for (const cp of customPresets) {
    if (!isUsableCustomPreset(cp)) continue;

    // Never shadow an llm.toml / process-wide preset — the base entry
    // keeps resolving under its public id.
    if (hasPreset.call(deps.presetRegistry, cp.id)) continue;

    const key = overlayPresetKey(cp);
    const current = presetRefs.get(key);
    if (current !== undefined) {
      // Identical (id, config) already registered by a concurrent
      // request — safe to share, just take a reference.
      presetRefs.set(key, current + 1);
    } else {
      addPreset.call(deps.presetRegistry, {
        id: key,
        name: cp.name || cp.id,
        provider: cp.provider,
        model: cp.model,
        ...(cp.protocol ? { protocol: cp.protocol } : {}),
        ...(cp.baseUrl ? { baseUrl: cp.baseUrl } : {}),
        tier: "medium",
        supportedModes: ["text", "stream"],
        enabled: true,
        tag: "text",
        // Untrusted request origin — env keys must not bind to it, and the
        // provider registry resolves unknown providers ephemerally for it.
        requestScoped: true,
      });
      presetRefs.set(key, 1);
    }
    ownedPresetKeys.push(key);
  }

  if (ownedPresetKeys.length === 0) {
    return noop;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const key of ownedPresetKeys) {
      decrementRef(presetRefs, key, () =>
        removePreset.call(deps.presetRegistry, key),
      );
    }
  };
}

/**
 * Resolve a public preset id to the scoped registry id registered by
 * THIS request's overlay.
 *
 * Only consults the caller's own `overrides` — a request can never reach
 * an overlay registration it didn't declare itself. Falls through
 * to the input unchanged when the id names no usable custom preset, when
 * the scoped id isn't registered (overlay not applied), or when a base
 * registry preset shadows the custom one.
 */
export function resolveOverlayPresetId(
  presetId: string | undefined,
  overrides: SlotOverridesInput | undefined,
  hasPreset: ((id: string) => boolean) | undefined,
): string | undefined {
  if (!presetId || !hasPreset) return presetId;
  const customPresets = overrides?.customPresets;
  if (!customPresets || customPresets.length === 0) return presetId;

  for (const cp of customPresets) {
    if (cp.id !== presetId || !isUsableCustomPreset(cp)) continue;
    const key = overlayPresetKey(cp);
    // Registered scoped id → use it; otherwise (base preset shadows the
    // custom one, or the overlay wasn't applied) keep the public id.
    return hasPreset(key) ? key : presetId;
  }
  return presetId;
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
};
