import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeProviderKeyMap, providerApiKeysFromEnv } from "@covel/shared";
import { parseEnvLines } from "./env-file.js";

/**
 * Which provider keys the process environment decides instead of the key the
 * player saved in Settings.
 *
 * The environment (shell, `.env`, `.env.llm`) outranks `keys.env`, and the
 * server cannot tell where a value in `process.env` came from once the files
 * are merged. It can tell whether the value is what `keys.env` held when the
 * process started: if not, the environment supplied it and wins again at the
 * next start, whatever the player saves meanwhile.
 */
let bootEnvKeys: Record<string, string> = {};
let bootSavedKeys: Record<string, string> = {};
let bootCaptured = false;

function readSavedKeys(covelHome: string): Record<string, string> {
  const file = join(covelHome, "keys.env");
  if (!existsSync(file)) return {};
  try {
    const raw: Record<string, string> = {};
    for (const [key, value] of parseEnvLines(readFileSync(file, "utf-8")))
      raw[key] = value;
    return normalizeProviderKeyMap(raw);
  } catch {
    return {};
  }
}

/** Call once at start, before the player can save a key. */
export function captureBootKeySources(covelHome: string | null): void {
  bootEnvKeys = providerApiKeysFromEnv();
  bootSavedKeys = covelHome ? readSavedKeys(covelHome) : {};
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
        value !== bootSavedKeys[provider] &&
        saved[provider] !== undefined &&
        saved[provider] !== value,
    )
    .map(([provider]) => provider)
    .sort();
}
