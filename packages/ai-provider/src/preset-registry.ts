import type { ModelProfile, PresetConfig, ResolvedTarget } from "./types.js";

/** Fallback context window size when synthesizing a profile from a preset. */
const SYNTHETIC_CONTEXT_WINDOW = 64_000;

/**
 * Create a preset registry that resolves preset IDs to model targets.
 *
 * Supports:
 * - Runtime and persisted profiles/presets (merged by ID)
 * - Default preset selection
 * - Fallback chain traversal
 * - Project/session overrides
 * - Embedding target resolution
 */
export function createPresetRegistry(options: {
  profiles: ModelProfile[];
  presets: PresetConfig[];
}) {
  const profiles = new Map<string, ModelProfile>();
  const presets = new Map<string, PresetConfig>();

  for (const p of options.profiles) profiles.set(p.id, p);
  for (const p of options.presets) presets.set(p.id, p);

  /** List all registered profiles. */
  function listProfiles(): ModelProfile[] {
    return Array.from(profiles.values());
  }

  /** List all registered presets. */
  function listPresets(): PresetConfig[] {
    return Array.from(presets.values());
  }

  /** Resolve a single preset by ID (or find the default). */
  function resolvePreset(presetId?: string): PresetConfig | null {
    if (!presetId) {
      return Array.from(presets.values()).find((p) => p.isDefault) ?? null;
    }

    const preset = presets.get(presetId) ?? null;
    if (!preset) {
      throw new Error(`Preset registry: preset "${presetId}" not found.`);
    }
    if (!preset.enabled) {
      throw new Error(`Preset registry: preset "${presetId}" is disabled.`);
    }
    return preset;
  }

  /**
   * Resolve the primary text target (profile + preset).
   * Applies optional project/session overrides.
   */
  function resolveTextTarget(input: {
    presetId?: string;
    projectOverride?: {
      preset?: Partial<PresetConfig>;
      profile?: Partial<ModelProfile> & Pick<ModelProfile, "id">;
    };
    sessionOverride?: {
      preset?: Partial<PresetConfig>;
      profile?: Partial<ModelProfile> & Pick<ModelProfile, "id">;
    };
  }): ResolvedTarget {
    const basePreset = resolvePreset(input.presetId);
    const preset = basePreset
      ? {
          ...basePreset,
          ...input.projectOverride?.preset,
          ...input.sessionOverride?.preset,
        }
      : null;

    const targetProfileId =
      input.sessionOverride?.profile?.id ??
      input.projectOverride?.profile?.id ??
      preset?.tier;

    if (!targetProfileId) {
      throw new Error("Preset registry: no text profile target resolved.");
    }

    const baseProfile = profiles.get(targetProfileId);

    // If no profile exists but we have a preset, synthesize a profile from it
    if (!baseProfile && !preset) {
      throw new Error(
        `Preset registry: profile "${targetProfileId}" not found.`,
      );
    }

    const effectiveProfile: ModelProfile = baseProfile
      ? {
          ...baseProfile,
          ...input.projectOverride?.profile,
          ...input.sessionOverride?.profile,
        }
      : {
          id: preset!.tier,
          tier: preset!.tier,
          provider: preset!.provider,
          model: preset!.model,
          contextWindow: SYNTHETIC_CONTEXT_WINDOW,
          latencyClass: "medium",
          costClass: "medium",
          supportedModes: preset!.supportedModes,
          ...input.projectOverride?.profile,
          ...input.sessionOverride?.profile,
        };

    return { profile: effectiveProfile, preset };
  }

  /**
   * Resolve an embedding target.
   *
   * - If `presetId` is provided and that preset supports embedding, use
   *   it (overriding the default). The profile is synthesized from the
   *   preset so routing works without requiring a paired profile entry.
   * - Otherwise return the "embed-default" profile and the first preset
   *   declaring `output: ["embedding"]`, if any.
   * - Throws when no embedding target is configured at all.
   */
  function resolveEmbeddingTarget(input?: {
    presetId?: string;
  }): ResolvedTarget {
    // Explicit preset path — user picked a specific embed slot.
    if (input?.presetId) {
      const preset = presets.get(input.presetId);
      if (!preset) {
        throw new Error(
          `Preset registry: preset "${input.presetId}" not found.`,
        );
      }
      if (!preset.enabled) {
        throw new Error(
          `Preset registry: preset "${input.presetId}" is disabled.`,
        );
      }
      if (!preset.supportedModes.includes("embed")) {
        throw new Error(
          `Preset registry: preset "${input.presetId}" does not support embedding.`,
        );
      }
      const syntheticProfile: ModelProfile = {
        id: "embed-default",
        tier: "embed-default",
        provider: preset.provider,
        model: preset.model,
        contextWindow:
          preset.capability?.contextWindow ?? SYNTHETIC_CONTEXT_WINDOW,
        latencyClass: "medium",
        costClass: "medium",
        supportedModes: ["embed"],
      };
      return { profile: syntheticProfile, preset };
    }

    // Default path — use the first embed profile synthesized by the loader
    // and (optionally) the matching preset for baseUrl/protocol hints.
    const profile = profiles.get("embed-default") ?? null;
    const preset =
      Array.from(presets.values()).find((p) =>
        p.supportedModes.includes("embed"),
      ) ?? null;

    if (!profile && !preset) {
      throw new Error(
        'Preset registry: no embedding target configured. Add an embed slot to llm.toml (output = ["embedding"]) or register an "embed-default" profile programmatically.',
      );
    }

    const effectiveProfile: ModelProfile = profile ?? {
      id: "embed-default",
      tier: "embed-default",
      provider: preset!.provider,
      model: preset!.model,
      contextWindow:
        preset!.capability?.contextWindow ?? SYNTHETIC_CONTEXT_WINDOW,
      latencyClass: "medium",
      costClass: "medium",
      supportedModes: ["embed"],
    };
    return { profile: effectiveProfile, preset };
  }

  /**
   * Build an ordered fallback chain for a preset.
   * Used by the gateway for retry routing.
   */
  function resolveTextTargetChain(input: {
    presetId?: string;
  }): ResolvedTarget[] {
    const primary = resolveTextTarget({ presetId: input.presetId });
    const chain: ResolvedTarget[] = [primary];
    const visited = new Set<string>();

    if (primary.preset?.id) visited.add(primary.preset.id);

    collectFallbacks(primary.preset?.fallbackPresetIds ?? []);
    return chain;

    function collectFallbacks(ids: string[]) {
      for (const id of ids) {
        if (visited.has(id)) continue;
        visited.add(id);
        try {
          const target = resolveTextTarget({ presetId: id });
          chain.push(target);
          collectFallbacks(target.preset?.fallbackPresetIds ?? []);
        } catch (err) {
          console.warn(
            `[ai-provider] Failed to resolve fallback preset "${id}":`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  /** Register (or overwrite) a preset at runtime (e.g. custom presets from the frontend). */
  function addPreset(preset: PresetConfig): void {
    presets.set(preset.id, preset);
  }

  /** Remove a preset by ID. */
  function removePreset(id: string): void {
    presets.delete(id);
  }

  /** Check whether a preset id is registered (enabled or not). */
  function hasPreset(id: string): boolean {
    return presets.has(id);
  }

  return {
    listProfiles,
    listPresets,
    resolvePreset,
    resolveTextTarget,
    resolveEmbeddingTarget,
    resolveTextTargetChain,
    addPreset,
    removePreset,
    hasPreset,
  };
}
