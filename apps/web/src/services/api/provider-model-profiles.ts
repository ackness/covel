export interface ProviderModelEntry {
  /** Stable internal reference used by slot bindings and request overlays. */
  ref: string;
  /** Opaque ID sent to the provider API without normalization. */
  modelId: string;
  name?: string;
}

export interface ProviderModelProfile {
  /** Provider/key namespace, for example `deepseek` or `openai`. */
  id: string;
  name: string;
  baseUrl: string;
  protocol?: string;
  models: ProviderModelEntry[];
}

export interface LegacyCustomPresetShape {
  id: string;
  name: string;
  provider: string;
  baseUrl?: string;
  model: string;
  protocol?: string;
}

/** Convert old model-per-preset storage into provider-first profiles. */
export function profilesFromLegacyPresets(
  presets: readonly LegacyCustomPresetShape[],
): ProviderModelProfile[] {
  const profiles = new Map<string, ProviderModelProfile>();
  for (const preset of presets) {
    const providerId = preset.provider.trim();
    const modelId = preset.model.trim();
    if (!providerId || !modelId) continue;

    let profile = profiles.get(providerId);
    if (!profile) {
      profile = {
        id: providerId,
        name: providerId,
        baseUrl: preset.baseUrl?.trim() ?? "",
        ...(preset.protocol ? { protocol: preset.protocol } : {}),
        models: [],
      };
      profiles.set(providerId, profile);
    }
    if (profile.models.some((model) => model.ref === preset.id)) continue;
    profile.models.push({
      ref: preset.id,
      modelId,
      ...(preset.name ? { name: preset.name } : {}),
    });
  }
  return [...profiles.values()];
}

/** Compile provider-first storage into the existing request overlay contract. */
export function flattenProviderProfiles(
  profiles: readonly ProviderModelProfile[],
): LegacyCustomPresetShape[] {
  return profiles.flatMap((profile) =>
    profile.models
      .filter((model) => model.ref.trim() && model.modelId.trim())
      .map((model) => ({
        id: model.ref,
        name: model.name?.trim() || model.modelId.trim(),
        provider: profile.id,
        baseUrl: profile.baseUrl,
        model: model.modelId.trim(),
        ...(profile.protocol ? { protocol: profile.protocol } : {}),
      })),
  );
}

export interface UpsertProviderModelInput {
  providerId: string;
  providerName?: string;
  baseUrl: string;
  protocol?: string;
  modelId: string;
  modelName?: string;
}

export function upsertProviderModel(
  profiles: readonly ProviderModelProfile[],
  input: UpsertProviderModelInput,
  createRef: () => string = () => `custom_${crypto.randomUUID()}`,
): { profiles: ProviderModelProfile[]; modelRef: string } {
  const providerId = input.providerId.trim();
  const modelId = input.modelId.trim();
  if (!providerId || !modelId) {
    throw new Error("providerId and modelId are required");
  }

  const existingProfile = profiles.find((profile) => profile.id === providerId);
  const existingModel = existingProfile?.models.find(
    (model) => model.modelId === modelId,
  );
  if (existingModel) {
    return { profiles: [...profiles], modelRef: existingModel.ref };
  }

  const modelRef = createRef();
  const model: ProviderModelEntry = {
    ref: modelRef,
    modelId,
    ...(input.modelName?.trim() ? { name: input.modelName.trim() } : {}),
  };
  if (!existingProfile) {
    return {
      profiles: [
        ...profiles,
        {
          id: providerId,
          name: input.providerName?.trim() || providerId,
          baseUrl: input.baseUrl.trim(),
          ...(input.protocol ? { protocol: input.protocol } : {}),
          models: [model],
        },
      ],
      modelRef,
    };
  }

  return {
    profiles: profiles.map((profile) =>
      profile.id === providerId
        ? { ...profile, models: [...profile.models, model] }
        : profile,
    ),
    modelRef,
  };
}
