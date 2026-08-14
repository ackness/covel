import type {
  CustomPreset,
  PresetSummary,
  ProviderModelProfile,
} from "@/services/api.js";

export interface ProviderCatalogEntry {
  id: string;
  baseUrl: string;
  protocol: string;
  serverModels: PresetSummary[];
  localProfile?: ProviderModelProfile;
}

export interface ProviderDraft {
  providerId: string;
  baseUrl: string;
  protocol: string;
  modelIds: string;
}

export const EMPTY_PROVIDER_DRAFT: ProviderDraft = {
  providerId: "",
  baseUrl: "",
  protocol: "openai-chat-v1",
  modelIds: "",
};

export function buildProviderCatalog(
  presets: readonly PresetSummary[],
  profiles: readonly ProviderModelProfile[],
): ProviderCatalogEntry[] {
  const byId = new Map<string, ProviderCatalogEntry>();
  for (const preset of presets) {
    const entry = byId.get(preset.provider) ?? {
      id: preset.provider,
      baseUrl: preset.baseUrl ?? "",
      protocol: preset.protocol ?? "openai-chat-v1",
      serverModels: [],
    };
    entry.serverModels.push(preset);
    if (!entry.baseUrl && preset.baseUrl) entry.baseUrl = preset.baseUrl;
    byId.set(preset.provider, entry);
  }
  for (const profile of profiles) {
    const entry = byId.get(profile.id) ?? {
      id: profile.id,
      baseUrl: profile.baseUrl,
      protocol: profile.protocol ?? "openai-chat-v1",
      serverModels: [],
    };
    entry.localProfile = profile;
    if (profile.baseUrl) entry.baseUrl = profile.baseUrl;
    if (profile.protocol) entry.protocol = profile.protocol;
    byId.set(profile.id, entry);
  }
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export function parseModelIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n|,/)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

const MAX_PROVIDER_ID_LENGTH = 100;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_BASE_URL_LENGTH = 500;
const SUPPORTED_PROVIDER_PROTOCOLS = new Set([
  "openai-chat-v1",
  "openai-responses-v1",
  "anthropic-messages-v1",
]);

/**
 * Clamp an imported profile from an untrusted export file: only http(s)
 * base URLs survive (anything else is dropped, not kept), every field is
 * length-bounded, and models without a usable ref/modelId are discarded.
 * Returns null when nothing usable remains.
 */
export function sanitizeImportedProfile(
  value: unknown,
): ProviderModelProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const profile = value as Record<string, unknown>;
  if (typeof profile.id !== "string" || !Array.isArray(profile.models)) {
    return null;
  }

  const id = profile.id.trim().slice(0, MAX_PROVIDER_ID_LENGTH);
  if (!id) return null;

  const seenRefs = new Set<string>();
  const seenModelIds = new Set<string>();
  const models = profile.models.flatMap(
    (value): ProviderModelProfile["models"] => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
      const model = value as Record<string, unknown>;
      if (typeof model.ref !== "string" || typeof model.modelId !== "string") {
        return [];
      }
      const ref = model.ref.trim().slice(0, MAX_PROVIDER_ID_LENGTH);
      const modelId = model.modelId.trim().slice(0, MAX_MODEL_ID_LENGTH);
      if (!ref || !modelId || seenRefs.has(ref) || seenModelIds.has(modelId)) {
        return [];
      }
      seenRefs.add(ref);
      seenModelIds.add(modelId);
      const name =
        typeof model.name === "string"
          ? model.name.trim().slice(0, MAX_PROVIDER_ID_LENGTH)
          : "";
      return [{ ref, modelId, ...(name ? { name } : {}) }];
    },
  );
  if (models.length === 0) return null;

  const name =
    typeof profile.name === "string"
      ? profile.name.trim().slice(0, MAX_PROVIDER_ID_LENGTH)
      : "";
  const rawBaseUrl =
    typeof profile.baseUrl === "string"
      ? profile.baseUrl.trim().slice(0, MAX_BASE_URL_LENGTH)
      : "";
  let baseUrl = "";
  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      baseUrl = rawBaseUrl;
    }
  } catch {
    // Invalid and non-http(s) URLs fall back to the provider default.
  }
  const protocol =
    typeof profile.protocol === "string" &&
    SUPPORTED_PROVIDER_PROTOCOLS.has(profile.protocol)
      ? profile.protocol
      : undefined;

  return {
    id,
    name: name || id,
    baseUrl,
    ...(protocol ? { protocol } : {}),
    models,
  };
}

/** Sanitize each v2 profile independently so one malformed entry is isolated. */
export function sanitizeImportedProfiles(
  values: readonly unknown[],
): ProviderModelProfile[] {
  return values
    .map(sanitizeImportedProfile)
    .filter((profile): profile is ProviderModelProfile => profile !== null);
}

export function isLegacyPreset(value: unknown): value is CustomPreset {
  if (!value || typeof value !== "object") return false;
  const preset = value as Partial<CustomPreset>;
  return (
    typeof preset.id === "string" &&
    typeof preset.name === "string" &&
    typeof preset.provider === "string" &&
    typeof preset.model === "string"
  );
}
