import type { PresetSummary } from "@/services/api.js";
import { PROVIDERS } from "./constants.js";
import type { ProviderFormState } from "./types.js";

export function emptyFormState(
  initialProvider = PROVIDERS[0].id,
): ProviderFormState {
  return {
    selected: initialProvider,
    apiKey: "",
    keyVisible: false,
    builtInModel: "",
    customBaseUrl: "",
    customModel: "",
    customProviderName: "",
  };
}

export function providerOptionLabel(providerId: string): string {
  return PROVIDERS.find((item) => item.id === providerId)?.name ?? providerId;
}

export function modelOptionsForProvider(
  presets: PresetSummary[],
  providerId: string,
): string[] {
  return [
    ...new Set(
      presets
        .filter((preset) => preset.enabled && preset.provider === providerId)
        .map((preset) => preset.model),
    ),
  ];
}

export function defaultModelForProvider(
  presets: PresetSummary[],
  providerId: string,
): string {
  return modelOptionsForProvider(presets, providerId)[0] ?? "";
}
