import { providerKeyToId } from "@covel/shared";

export interface ProviderModelEntry {
  /** Stable internal reference used by slot bindings and request overlays. */
  ref: string;
  /** Opaque ID sent to the provider API without normalization. */
  modelId: string;
  name?: string;
}

export interface ProviderModelProfile {
  /** Stable connection and API-key namespace used by the settings UI. */
  id: string;
  /** Provider family used to inherit defaults when `id` is connection-specific. */
  provider?: string;
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

function normalizeProviderId(input: string): string {
  return providerKeyToId(input) ?? input.trim();
}

/** Convert old model-per-preset storage into provider-first profiles. */
export function profilesFromLegacyPresets(
  presets: readonly LegacyCustomPresetShape[],
): ProviderModelProfile[] {
  const profiles = new Map<string, ProviderModelProfile>();
  const usedProfileIds = new Set<string>();
  const reservedProviderIds = new Set(
    presets
      .map((preset) => normalizeProviderId(preset.provider))
      .filter(Boolean),
  );
  const connectionKeysByProvider = new Map<string, Set<string>>();
  for (const preset of presets) {
    const providerId = normalizeProviderId(preset.provider);
    if (!providerId || !preset.model.trim()) continue;
    const connectionKey = JSON.stringify([
      providerId,
      preset.baseUrl?.trim() ?? "",
      preset.protocol?.trim() || "",
    ]);
    const connectionKeys =
      connectionKeysByProvider.get(providerId) ?? new Set();
    connectionKeys.add(connectionKey);
    connectionKeysByProvider.set(providerId, connectionKeys);
  }
  const providerConnectionCounts = new Map<string, number>();

  const allocateProfileId = (providerId: string, presetId: string): string => {
    const connectionCount = providerConnectionCounts.get(providerId) ?? 0;
    providerConnectionCounts.set(providerId, connectionCount + 1);
    if (
      connectionKeysByProvider.get(providerId)?.size === 1 &&
      !usedProfileIds.has(providerId)
    ) {
      usedProfileIds.add(providerId);
      return providerId;
    }

    const suffix = presetId.trim() || String(connectionCount + 1);
    const rawStem = `${providerId}-${suffix}`;
    const stem = providerKeyToId(rawStem) ?? rawStem;
    let candidate = stem;
    let collision = 2;
    while (
      usedProfileIds.has(candidate) ||
      reservedProviderIds.has(candidate)
    ) {
      candidate = `${stem}-${collision}`;
      collision += 1;
    }
    usedProfileIds.add(candidate);
    return candidate;
  };

  for (const preset of presets) {
    const providerId = normalizeProviderId(preset.provider);
    const modelId = preset.model.trim();
    if (!providerId || !modelId) continue;
    const baseUrl = preset.baseUrl?.trim() ?? "";
    const protocol = preset.protocol?.trim() || undefined;
    const connectionKey = JSON.stringify([providerId, baseUrl, protocol ?? ""]);

    let profile = profiles.get(connectionKey);
    if (!profile) {
      const profileId = allocateProfileId(providerId, preset.id);
      profile = {
        id: profileId,
        ...(profileId === providerId ? {} : { provider: providerId }),
        name: providerId,
        baseUrl,
        ...(protocol ? { protocol } : {}),
        models: [],
      };
      profiles.set(connectionKey, profile);
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
  const providerId = normalizeProviderId(input.providerId);
  const modelId = input.modelId.trim();
  if (!providerId || !modelId) {
    throw new Error("providerId and modelId are required");
  }

  const canonicalProfiles = profiles.map((profile) => {
    const id = normalizeProviderId(profile.id);
    const provider = profile.provider
      ? normalizeProviderId(profile.provider)
      : undefined;
    return {
      ...profile,
      id,
      ...(provider ? { provider } : {}),
    };
  });
  const existingProfile = canonicalProfiles.find(
    (profile) => profile.id === providerId,
  );
  const existingModel = existingProfile?.models.find(
    (model) => model.modelId === modelId,
  );
  if (existingModel) {
    return { profiles: canonicalProfiles, modelRef: existingModel.ref };
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
        ...canonicalProfiles,
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
    profiles: canonicalProfiles.map((profile) =>
      profile.id === providerId
        ? { ...profile, models: [...profile.models, model] }
        : profile,
    ),
    modelRef,
  };
}
