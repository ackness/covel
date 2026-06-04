import fs from "node:fs";
import path from "node:path";

import { normalizeProviderKeyMap, toApiKeyEnvMap } from "./provider-keys.js";

export function loadEnvFiles(baseDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [".env", ".env.llm"]) {
    const filePath = path.join(baseDir, name);
    if (!fs.existsSync(filePath)) continue;
    parseEnvFileInto(filePath, result);
  }
  return result;
}

/**
 * Read `~/.covel/keys.env` into a provider-id keyed record for the renderer.
 * Missing file is fine (fresh install). Legacy bare keys like `deepseek=...`
 * are folded into the same shape as `DEEPSEEK_API_KEY=...`.
 */
export function loadKeysEnv(keysFile: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(keysFile)) return result;
  parseEnvFileInto(keysFile, result);
  return normalizeProviderKeyMap(result);
}

export function loadKeysEnvForChild(keysFile: string): Record<string, string> {
  return toApiKeyEnvMap(loadKeysEnv(keysFile));
}

export function saveKeysEnv(
  keysFile: string,
  keys: Record<string, string>,
): void {
  const envKeys = toApiKeyEnvMap(keys);
  const body =
    `# Covel provider API keys. One KEY=VALUE per line.\n` +
    `# Example:\n#   DEEPSEEK_API_KEY=sk-xxx\n#   OPENAI_API_KEY=sk-xxx\n\n` +
    Object.entries(envKeys)
      // audit M2: reject values with CR/LF — a newline would inject extra
      // `KEY=VALUE` lines and poison other providers' key parsing.
      .filter(([k, v]) => {
        if (!k || typeof v !== "string" || !v.trim()) return false;
        if (/[\r\n]/.test(v)) {
          console.warn(
            `[env-files] Skipping key "${k}": value contains a newline`,
          );
          return false;
        }
        return true;
      })
      .map(([k, v]) => `${k}=${v.trim()}`)
      .join("\n") +
    "\n";
  fs.mkdirSync(path.dirname(keysFile), { recursive: true });
  // mode in writeFileSync only applies when creating a new file. Re-assert
  // 0600 after the write so an existing looser-permission file gets tightened
  // (audit M1). chmod is a no-op on Windows but does not throw.
  fs.writeFileSync(keysFile, body, { mode: 0o600 });
  fs.chmodSync(keysFile, 0o600);
}

function parseEnvFileInto(
  filePath: string,
  into: Record<string, string>,
): void {
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    into[key] = val;
  }
}
