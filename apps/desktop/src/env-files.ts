import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  parseProviderKeysEnv,
  providerKeyToId,
  toApiKeyEnvMap,
} from "@covel/shared";

function loadEnvFiles(baseDir: string): Record<string, string> {
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
 * Only *_API_KEY entries are keys. Unrecognized lines are preserved on save.
 */
export function loadKeysEnv(keysFile: string): Record<string, string> {
  if (!fs.existsSync(keysFile)) return {};
  return parseProviderKeysEnv(fs.readFileSync(keysFile, "utf-8")).keys;
}

/** Shell > .env.llm > .env. The sidecar loads saved keys separately. */
export function loadChildEnvironment(
  baseDir: string,
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  const shell = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return {
    ...loadEnvFiles(baseDir),
    ...shell,
  };
}

/** Apply one explicit patch when the sidecar is unavailable. */
export function patchKeysEnv(
  keysFile: string,
  patch: Record<string, string | null>,
): void {
  const keys = loadKeysEnv(keysFile);
  for (const [name, value] of Object.entries(patch)) {
    const provider = providerKeyToId(name);
    if (!provider) continue;
    if (value === null || !value.trim()) delete keys[provider];
    else keys[provider] = value;
  }
  saveKeysEnv(keysFile, keys);
}

export function saveKeysEnv(
  keysFile: string,
  keys: Record<string, string>,
): void {
  const envKeys = toApiKeyEnvMap(keys);
  const unrecognized = fs.existsSync(keysFile)
    ? parseProviderKeysEnv(fs.readFileSync(keysFile, "utf-8")).unrecognizedLines
    : [];
  const body =
    `# Covel provider API keys. One KEY=VALUE per line.\n` +
    `# Example:\n#   DEEPSEEK_API_KEY=sk-xxx\n#   OPENAI_API_KEY=sk-xxx\n\n` +
    Object.entries(envKeys)
      // audit M2: reject values with CR/LF — a newline would inject extra
      // `KEY=VALUE` lines and poison other providers' key parsing.
      .filter(([k, v]) => {
        if (!k || typeof v !== "string" || !v.trim()) return false;
        if (/[\r\n]/.test(v)) {
          throw new Error("Provider keys must be single-line strings");
        }
        return true;
      })
      .map(([k, v]) => `${k}=${v.trim()}`)
      .join("\n") +
    "\n";
  fs.mkdirSync(path.dirname(keysFile), { recursive: true });
  const temporaryFile = `${keysFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temporaryFile,
      body + unrecognized.map((line) => `${line}\n`).join(""),
      { mode: 0o600, flag: "wx" },
    );
    // Set permissions before publishing: a failed write or chmod must leave
    // the existing keys intact, and rename is the last required operation.
    fs.chmodSync(temporaryFile, 0o600);
    fs.renameSync(temporaryFile, keysFile);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Preserve the original filesystem error.
    }
    throw error;
  }
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
