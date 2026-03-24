import type { PresetMetadata } from "../../model-gateway/src/index.js";

export interface PersistedPresetRecord extends PresetMetadata {
  apiKey?: string;
}

export interface PersistedPresetMetadata extends PresetMetadata {}

export interface PresetMetadataStore {
  save(input: PersistedPresetRecord): Promise<void>;
  patch(
    presetId: string,
    input: Partial<PersistedPresetRecord>
  ): Promise<PersistedPresetMetadata>;
  getById(id: string): Promise<PersistedPresetMetadata | null>;
  list(): Promise<PersistedPresetMetadata[]>;
}

export type StorageRepositoriesWithPresets = {
  presets: PresetMetadataStore;
};

export function stripPresetSecrets(input: PersistedPresetRecord): PersistedPresetMetadata {
  const { apiKey: _apiKey, ...metadata } = input;
  return metadata;
}
