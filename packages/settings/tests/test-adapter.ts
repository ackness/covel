import type { SettingKey, SettingsBackendAdapter } from "../src/types.js";

export function createMemoryAdapter(
  initial: Record<SettingKey, unknown> = {},
  initialSecrets: Record<string, string> = {},
): SettingsBackendAdapter & {
  readEntries(): Record<SettingKey, unknown>;
  readSecrets(): Record<string, string>;
} {
  let entries: Record<SettingKey, unknown> = { ...initial };
  let secrets: Record<string, string> = { ...initialSecrets };
  return {
    async load() {
      return { ...entries };
    },
    async save(next) {
      entries = { ...next };
    },
    async loadSecrets() {
      return { ...secrets };
    },
    async saveSecrets(next) {
      for (const [provider, value] of Object.entries(next)) {
        if (value === null) delete secrets[provider];
        else secrets[provider] = value;
      }
    },
    readEntries: () => ({ ...entries }),
    readSecrets: () => ({ ...secrets }),
  };
}
