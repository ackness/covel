export type ModelTier = "small" | "medium" | "large" | "embed-default";
export type SupportedMode = "text" | "object" | "stream" | "embed";

export interface ModelProfile {
  id: string;
  tier: ModelTier;
  provider: string;
  model: string;
  contextWindow: number;
  latencyClass: string;
  costClass: string;
  supportedModes: SupportedMode[];
}

export interface PresetMetadata {
  id: string;
  name: string;
  provider: string;
  model: string;
  tier: Exclude<ModelTier, "embed-default">;
  baseUrl?: string;
  supportedModes: SupportedMode[];
  enabled: boolean;
  isDefault: boolean;
  scope: string;
}

type PartialProfileOverride = Partial<ModelProfile> & Pick<ModelProfile, "id">;
type PartialPresetOverride = Partial<PresetMetadata>;

function mergeById<T extends { id: string }>(
  runtimeValues: T[],
  persistedValues: T[]
): Map<string, T> {
  const merged = new Map<string, T>();

  for (const value of runtimeValues) {
    merged.set(value.id, value);
  }

  for (const value of persistedValues) {
    const existing = merged.get(value.id);
    merged.set(value.id, existing ? { ...existing, ...value } : value);
  }

  return merged;
}

export function createModelProfileRegistry(options: {
  runtimeProfiles: ModelProfile[];
  runtimePresets?: PresetMetadata[];
  persistedProfiles?: ModelProfile[];
  persistedPresets?: PresetMetadata[];
}) {
  const profiles = mergeById(options.runtimeProfiles, options.persistedProfiles ?? []);
  const presets = mergeById(options.runtimePresets ?? [], options.persistedPresets ?? []);

  function list(): ModelProfile[] {
    return Array.from(profiles.values());
  }

  function resolvePreset(presetId?: string): PresetMetadata | null {
    if (!presetId) {
      const defaultPreset = Array.from(presets.values()).find((preset) => preset.isDefault);
      return defaultPreset ?? null;
    }

    const preset = presets.get(presetId) ?? null;
    if (!preset) {
      throw new Error(`Model profile registry error: preset "${presetId}" does not exist.`);
    }

    if (!preset.enabled) {
      throw new Error(`Model profile registry error: preset "${presetId}" is disabled.`);
    }

    return preset;
  }

  function resolveTextTarget(input: {
    presetId?: string;
    projectOverride?: {
      preset?: PartialPresetOverride;
      profile?: PartialProfileOverride;
    };
    sessionOverride?: {
      preset?: PartialPresetOverride;
      profile?: PartialProfileOverride;
    };
  }): { profile: ModelProfile; preset: PresetMetadata | null } {
    const basePreset = resolvePreset(input.presetId);
    const preset = basePreset
      ? {
          ...basePreset,
          ...input.projectOverride?.preset,
          ...input.sessionOverride?.preset
        }
      : null;

    const targetProfileId =
      input.sessionOverride?.profile?.id ??
      input.projectOverride?.profile?.id ??
      preset?.tier;

    if (!targetProfileId) {
      throw new Error("Model profile registry error: no text profile target could be resolved.");
    }

    const baseProfile = profiles.get(targetProfileId);
    if (!baseProfile) {
      throw new Error(`Model profile registry error: profile "${targetProfileId}" does not exist.`);
    }

    return {
      profile: {
        ...baseProfile,
        ...input.projectOverride?.profile,
        ...input.sessionOverride?.profile
      },
      preset
    };
  }

  function resolveEmbeddingTarget(_input: { presetId?: string }): {
    profile: ModelProfile;
    preset: null;
  } {
    const embeddingProfile = profiles.get("embed-default");
    if (!embeddingProfile) {
      throw new Error('Model profile registry error: profile "embed-default" does not exist.');
    }

    return {
      profile: embeddingProfile,
      preset: null
    };
  }

  return {
    list,
    resolveTextTarget,
    resolveEmbeddingTarget
  };
}
