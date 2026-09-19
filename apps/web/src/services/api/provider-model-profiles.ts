import { providerKeyToId, type ReasoningEffort } from "@covel/shared";

export interface ProviderModelEntry {
  reasoningEffort?: ReasoningEffort;
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

export interface CustomPreset {
  reasoningEffort?: ReasoningEffort;
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  protocol?: string;
}

function normalizeProviderId(input: string): string {
  return providerKeyToId(input) ?? input.trim();
}

/** Compile provider-first storage into the existing request overlay contract. */
export function flattenProviderProfiles(
  profiles: readonly ProviderModelProfile[],
): CustomPreset[] {
  return profiles.flatMap((profile) =>
    profile.models
      .filter((model) => model.ref.trim() && model.modelId.trim())
      .map((model) => ({
        ...(model.reasoningEffort
          ? { reasoningEffort: model.reasoningEffort }
          : {}),
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
  reasoningEffort?: ReasoningEffort;
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
    (model) =>
      model.modelId === modelId &&
      model.reasoningEffort === input.reasoningEffort &&
      (model.name?.trim() || modelId) === (input.modelName?.trim() || modelId),
  );
  if (existingModel) {
    return { profiles: canonicalProfiles, modelRef: existingModel.ref };
  }

  const modelRef = createRef();
  const model: ProviderModelEntry = {
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
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
