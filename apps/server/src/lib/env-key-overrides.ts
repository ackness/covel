import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProviderKeysEnv, providerApiKeysFromEnv } from "@covel/shared";

/** External keys are captured before saved keys are merged into process.env. */
let bootEnvKeys: Readonly<Record<string, string>> = {};
let bootCaptured = false;

function readSavedKeys(covelHome: string): Record<string, string> {
  const file = join(covelHome, "keys.env");
  if (!existsSync(file)) return {};
  try {
    return parseProviderKeysEnv(readFileSync(file, "utf-8")).keys;
  } catch {
    return {};
  }
}

/** Call once at start, before the player can save a key. */
export function captureBootKeySources(
  externalApiKeys: Readonly<Record<string, string>> = providerApiKeysFromEnv(),
): void {
  bootEnvKeys = { ...externalApiKeys };
  bootCaptured = true;
}

/**
 * Provider ids with a saved key that the environment overrides: the
 * environment holds a value that did not come from `keys.env` and differs from
 * the saved one.
 */
export function envOverriddenProviders(covelHome: string | null): string[] {
  if (!bootCaptured || !covelHome) return [];
  const saved = readSavedKeys(covelHome);
  return Object.entries(bootEnvKeys)
    .filter(
      ([provider, value]) =>
        saved[provider] !== undefined && saved[provider] !== value,
    )
    .map(([provider]) => provider)
    .sort();
}
